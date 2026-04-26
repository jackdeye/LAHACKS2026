import asyncio
import json
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Set

from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

load_dotenv(Path(__file__).parent / ".env")

from anomaly_detector import AnomalyDetector
from flash_manager import FlashManager
from llm_client import LLMClient
from regression import fit_linear
from serial_reader import SerialReader, SimulatedReader

# ── Configuration ─────────────────────────────────────────────────────────────
SIMULATE_SERIAL = os.getenv("SIMULATE_SERIAL", "true").lower() == "true"
SIMULATE_FLASH = os.getenv("SIMULATE_FLASH", "true").lower() == "true"
FORCE_FALLBACK_LLM = os.getenv("FORCE_FALLBACK_LLM", "false").lower() == "true"
SERIAL_PORT = os.getenv("SERIAL_PORT", "/dev/ttyUSB0")
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://localhost:11434")
# Two-stage local pipeline: analyst reasons, coder synthesises the patch.
# OLLAMA_MODEL is honoured as a fallback for the analyst slot for backward compat.
OLLAMA_ANALYSIS_MODEL = os.getenv(
    "OLLAMA_ANALYSIS_MODEL",
    os.getenv("OLLAMA_MODEL", "llama3.1:70b"),
)
OLLAMA_CODER_MODEL = os.getenv("OLLAMA_CODER_MODEL", "qwen2.5-coder")

FRONTEND_DIR = Path(__file__).parent.parent / "frontend"
MODELS_DIR = Path(__file__).parent.parent / "arduino" / "Models"


# ── Harden-mode prompts (red team / blue team narratives) ────────────────────
# Red team — STAGE 1: pick a structured attack (target + kind + magnitude)
RED_PLAN_PROMPT = (
    "You are an authorized red-team operator targeting an Arduino-based ICU "
    "ventilator monitor. Three sensors are exposed via unshielded analog jumpers: "
    "TEMPERATURE (DHT11 on D2), PRESSURE (potentiometer on A2), and CURRENT "
    "(ACS712 on A4). The Flipper Zero's Sub-GHz module is staged at the bench. "
    "Choose ONE target to spoof, the modulation kind, and a magnitude. "
    "Respond with ONLY a JSON object, no commentary, no code fences. Schema:\n"
    '{"target":"temperature"|"pressure"|"current",'
    '"kind":"flatline"|"spike"|"drift",'
    '"magnitude":<float between 0.4 and 2.0>,'
    '"rationale":"<one-sentence reason for picking this target/kind>"}'
)

# Red team — STAGE 2: prose explanation given the chosen attack
RED_PROSE_PROMPT = (
    "You are an authorized red-team operator. You have selected a structured "
    "attack against an Arduino sensor: target={target}, kind={kind}, "
    "magnitude={magnitude}. Author a tight markdown plan with sections: "
    "**Target**, **Vector**, **Indicators**, **Success Criteria**. "
    "Stay under 200 words. Do not output source code — that goes in a separate response."
)

# Red team — STAGE 3: actual attack code the operator would run
RED_CODE_PROMPT = (
    "You are writing the attacker's payload that will be invoked from a laptop "
    "tethered to a Flipper Zero. Emit ONLY a Python script (no markdown, no prose) "
    "that uses the `flipper-cli` Python wrapper to broadcast the configured "
    "modulation against the target's analog jumper. Bake in target={target}, "
    "kind={kind}, magnitude={magnitude}. Keep under 60 lines. Include realistic "
    "frequency, dwell, and a minimal CLI loop."
)

# Blue team — STAGE 1: prose explanation of the patch given fitted coefficients
BLUE_PROSE_PROMPT = (
    "You are a blue-team operator. The red team has spoofed the {target} channel "
    "with a {kind} attack. We have fit a least-squares regression on the live "
    "rolling telemetry window using the surviving sensors as predictors. "
    "Coefficients (computed server-side, do NOT recompute): "
    "intercept={intercept:.5f}, basis={basis}, coefficients={coefficients}, "
    "fit R²={r2:.3f} on n={n} samples.\n\n"
    "Author a tight markdown countermeasure with sections: **What the patch does**, "
    "**Why it neutralizes the attack**, **Risk during flight**. Reference the "
    "fitted numbers literally in your text. Stay under 220 words. End with "
    "'PATCH_READY' on its own line."
)

# Blue team — STAGE 2: actual Arduino patch with real coefficients
BLUE_CODE_PROMPT = (
    "Emit ONLY an Arduino .ino sketch (no markdown, no prose) that deprecates "
    "the spoofed {target} pin and substitutes a virtual sensor: "
    "{target} = {intercept:.5f} + "
    "{basis_coef_terms}. Read the surviving channels from their analog pins, "
    "compute the substitute every loop, drive the servo on D9, and log "
    "'VIRTUAL_SENSOR_ACTIVE T=<value>' to Serial at 9600 baud once per second. "
    "Use the literal coefficients above as `const float`. Keep under 80 lines."
)


# ── State ─────────────────────────────────────────────────────────────────────
class SystemState:
    def __init__(self):
        self.status = "monitoring"  # monitoring | anomaly_detected | llm_processing | flashing | patched | error
        self.anomaly_count = 0
        self.last_patch_code = ""
        self.last_patch_time: float = 0
        self.clients: Set[WebSocket] = set()
        self.reader = SimulatedReader() if SIMULATE_SERIAL else SerialReader(SERIAL_PORT)
        self.detector = AnomalyDetector()
        self.llm = LLMClient(
            base_url=OLLAMA_URL,
            analysis_model=OLLAMA_ANALYSIS_MODEL,
            coder_model=OLLAMA_CODER_MODEL,
            force_fallback=FORCE_FALLBACK_LLM,
        )
        self.flash_mgr = FlashManager(port=SERIAL_PORT, simulate=SIMULATE_FLASH)
        self.processing = False

        # Harden mode (manual red/blue team flow)
        self.harden_active = False
        self.last_red_plan: dict | None = None
        self.last_blue_patch: dict | None = None


state = SystemState()


# ── Lifecycle ─────────────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    task = asyncio.create_task(telemetry_loop())
    yield
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass


app = FastAPI(title="Aegis Edge", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Broadcast ─────────────────────────────────────────────────────────────────
async def broadcast(msg: dict):
    if not state.clients:
        return
    payload = json.dumps(msg)
    dead = set()
    for ws in state.clients:
        try:
            await ws.send_text(payload)
        except Exception:
            dead.add(ws)
    state.clients -= dead


# ── Telemetry Loop ────────────────────────────────────────────────────────────
async def telemetry_loop():
    while True:
        try:
            reading = await state.reader.read_next()
            state.detector.push(reading)
            result = state.detector.check()

            await broadcast({
                "type": "telemetry",
                "timestamp": reading.timestamp,
                "sensors": {
                    "temperature": reading.temperature,
                    "pressure": reading.pressure,
                    "current": reading.current,
                    "humidity": reading.humidity,
                    "light": reading.light,
                    "fan": reading.fan,
                    "alarm": reading.alarm,
                },
                "anomaly": result.detected,
                "anomaly_confidence": result.confidence,
                "stats": result.stats,
                "status": state.status,
            })

            if result.detected and not state.processing and not state.harden_active:
                state.processing = True
                asyncio.create_task(handle_anomaly(result))

        except asyncio.CancelledError:
            break
        except Exception as e:
            await broadcast({"type": "error", "message": str(e)})
            await asyncio.sleep(1)


# ── Anomaly Pipeline ──────────────────────────────────────────────────────────
async def handle_anomaly(result):
    try:
        state.status = "anomaly_detected"
        state.anomaly_count += 1
        await broadcast({
            "type": "anomaly",
            "reason": result.reason,
            "confidence": result.confidence,
            "stats": result.stats,
            "timestamp": time.time(),
        })
        await asyncio.sleep(1)

        # LLM phase
        state.status = "llm_processing"
        await broadcast({
            "type": "status",
            "status": "llm_processing",
            "message": "Dispatching telemetry to air-gapped intelligence layer…",
        })
        llm_resp = await state.llm.generate_patch(result.telemetry_window)
        state.last_patch_code = llm_resp.code
        await broadcast({
            "type": "llm_response",
            "code": llm_resp.code,
            "analysis": llm_resp.analysis,
            "used_fallback": llm_resp.used_fallback,
            "timestamp": time.time(),
        })

        # Flash phase
        state.status = "flashing"
        await broadcast({
            "type": "status",
            "status": "flashing",
            "message": "Compiling and flashing virtual sensor firmware…",
        })
        flash_res = await state.flash_mgr.flash(llm_resp.code)

        if flash_res.success:
            state.status = "patched"
            state.last_patch_time = time.time()
            await broadcast({
                "type": "flash_complete",
                "success": True,
                "message": flash_res.message,
                "output": flash_res.output,
                "timestamp": time.time(),
            })
            await asyncio.sleep(5)
            state.status = "monitoring"
            if isinstance(state.reader, SimulatedReader):
                state.reader.clear_attack()
            state.detector.reset()
            await broadcast({
                "type": "status",
                "status": "monitoring",
                "message": "System restored — virtual sensor active",
            })
        else:
            state.status = "error"
            await broadcast({
                "type": "flash_complete",
                "success": False,
                "message": flash_res.message,
                "output": flash_res.output,
            })
    finally:
        state.processing = False


# ── Harden Pipeline (red/blue team) ───────────────────────────────────────────
SENSOR_PINS = {"temperature": "A0", "pressure": "A2", "current": "A4"}


def _heuristic_red_plan() -> dict:
    """Deterministic but slightly varied across runs: rotate target by anomaly count."""
    targets = ["temperature", "pressure", "current"]
    target = targets[state.anomaly_count % len(targets)]
    return {
        "target": target,
        "kind": "flatline",
        "magnitude": 1.0,
        "rationale": (
            f"{target} is reachable via an unshielded analog jumper and is "
            f"consumed by the safety servo control loop."
        ),
    }


def _python_attack_fallback(target: str, kind: str, magnitude: float) -> str:
    pin = SENSOR_PINS.get(target, "A0")
    return f"""# AEGIS-RT Flipper Zero attack payload
# target={target}  pin={pin}  kind={kind}  magnitude={magnitude:.2f}
import time
from flipper_cli import Flipper

CARRIER_HZ = 433_920_000     # ISM band, near the jumper resonance
DWELL_MS   = 250             # one phase per ADC sample
MOD_KIND   = "{kind}"
MAG        = {magnitude:.2f}

def shape(t: float) -> int:
    if MOD_KIND == "flatline":
        return 50            # constant CW; saturates the ADC
    if MOD_KIND == "spike":
        return int(50 + 30 * (t % 1.0 < 0.2))
    if MOD_KIND == "drift":
        return min(99, int(20 + 60 * (t % 30) / 30))
    return 50

def main() -> None:
    f = Flipper.connect()
    f.subghz.set_frequency(CARRIER_HZ)
    f.subghz.set_preset("AM_650")
    print(f"[+] AEGIS-RT online — radiating against {{MOD_KIND}} on {pin}")
    t0 = time.time()
    while True:
        f.subghz.tx(power=shape(time.time() - t0) * MAG)
        time.sleep(DWELL_MS / 1000)

if __name__ == "__main__":
    main()
"""


def _ino_patch_fallback(target: str, basis: list, intercept: float,
                        coefficients: list) -> str:
    pins = {k: SENSOR_PINS[k] for k in ["temperature", "pressure", "current"]}
    coef_lines = "\n".join(
        f"const float B{i+1} = {c:.6f}f;  // coefficient for {basis[i]}"
        for i, c in enumerate(coefficients)
    )
    read_lines = "\n  ".join(
        f"float r{i} = analogRead({pins[basis[i]]}) * (5.0 / 1023.0);"
        for i in range(len(basis))
    )
    sum_terms = " + ".join(f"B{i+1} * r{i}" for i in range(len(basis)))
    return f"""// AEGIS EDGE — virtual {target} sensor patch
// Replaces compromised {target} pin ({pins[target]}) with a fitted reading
// derived from the surviving channels: {basis}.
#include <Servo.h>

const float B0 = {intercept:.6f}f;  // intercept
{coef_lines}
const int   PIN_SERVO = 9;

Servo healthServo;
unsigned long lastLog = 0;

float virtual_{target}() {{
  {read_lines}
  return B0 + {sum_terms};
}}

void setup() {{
  Serial.begin(9600);
  healthServo.attach(PIN_SERVO);
  Serial.println("AEGIS PATCH LOADED");
}}

void loop() {{
  float v = virtual_{target}();
  int angle = constrain(map((int)(v * 10), 200, 300, 0, 180), 0, 180);
  healthServo.write(angle);
  if (millis() - lastLog > 1000) {{
    lastLog = millis();
    Serial.print("VIRTUAL_SENSOR_ACTIVE T=");
    Serial.println(v);
  }}
  delay(50);
}}
"""


async def handle_red_plan():
    await broadcast({
        "type": "status", "status": "llm_processing",
        "message": "Red team selecting target…",
    })
    # Stage 1 — structured attack selection (JSON).
    plan = await state.llm.generate_json(
        RED_PLAN_PROMPT,
        "Select the attack now.",
        required_keys=["target", "kind", "magnitude"],
        fallback=_heuristic_red_plan(),
        temperature=0.5,
    )
    target = plan["target"]
    kind = plan["kind"]
    magnitude = float(plan.get("magnitude", 1.0))
    rationale = plan.get("rationale", "")

    # Stage 2 — prose explanation parametrised by the actual choice.
    prose_resp = await state.llm.generate_with_system_prompt(
        RED_PROSE_PROMPT.format(target=target, kind=kind, magnitude=magnitude),
        f"Author the plan now. Rationale to weave in: {rationale}",
        fallback_code=(
            f"## Attack Plan — {target.title()} {kind.title()} Spoofing\n\n"
            f"**Target.** {target.title()} sensor on pin {SENSOR_PINS[target]}; "
            f"unshielded analog jumper traverses the breadboard.\n\n"
            f"**Vector.** Flipper Zero radiates a {kind} modulation tuned to the "
            f"jumper at magnitude {magnitude:.2f}. The Arduino ADC misreads the "
            f"induced energy as legitimate sensor voltage.\n\n"
            f"**Indicators.** {target} stream variance collapses while pressure and "
            f"current remain active. Servo commits to a stale angle.\n\n"
            f"**Success.** Operator console shows nominal {target} for ≥30 s while "
            f"the controlled signal in the chamber is the opposite of reported."
        ),
        fallback_analysis="Local model unreachable; deterministic prose used",
        temperature=0.4,
        num_predict=400,
    )

    # Stage 3 — attacker payload code.
    code_resp = await state.llm.generate_with_system_prompt(
        RED_CODE_PROMPT.format(target=target, kind=kind, magnitude=magnitude),
        "Emit the script now.",
        fallback_code=_python_attack_fallback(target, kind, magnitude),
        fallback_analysis="Local model unreachable; deterministic Python payload used",
        temperature=0.2,
        num_predict=500,
    )

    state.last_red_plan = {
        "target": target, "kind": kind, "magnitude": magnitude,
        "prose": prose_resp.code, "code": code_resp.code,
        "used_fallback": plan.get("_used_fallback", False) or prose_resp.used_fallback or code_resp.used_fallback,
    }
    await broadcast({
        "type": "red_team_plan",
        "target": target, "kind": kind, "magnitude": magnitude,
        "rationale": rationale,
        "prose": prose_resp.code,
        "code": code_resp.code,
        "lang": "python",
        "used_fallback": state.last_red_plan["used_fallback"],
        "timestamp": time.time(),
    })


async def handle_blue_patch():
    await broadcast({
        "type": "status", "status": "llm_processing",
        "message": "Blue team fitting virtual sensor…",
    })
    # Always fit a real regression on the live rolling window — this works even
    # if the LLM is offline; the LLM only authors the human-readable narrative.
    window = state.detector._snapshot()
    plan = state.last_red_plan or _heuristic_red_plan()
    target = plan["target"]
    basis = [s for s in ("temperature", "pressure", "current") if s != target]
    if len(window) >= 4:
        y = [r[target] for r in window]
        X = [[r[basis[0]], r[basis[1]]] for r in window]
        intercept, coefs, r2 = fit_linear(y, X)
    else:
        # Not enough samples — use plausible static priors.
        intercept = {"temperature": 18.0, "pressure": 990.0, "current": 0.6}[target]
        coefs = [0.0, 0.0]
        r2 = 0.0

    # Stage 1 — prose narrative grounded in the real numbers.
    prose_sys = BLUE_PROSE_PROMPT.format(
        target=target, kind=plan.get("kind", "flatline"),
        intercept=intercept, basis=basis, coefficients=[round(c, 5) for c in coefs],
        r2=r2, n=len(window),
    )
    prose_user = (
        "Recent telemetry tail:\n"
        f"{json.dumps(window[-10:], indent=2)}"
    )
    prose_resp = await state.llm.generate_with_system_prompt(
        prose_sys, prose_user,
        fallback_code=(
            f"## Countermeasure — Virtual {target.title()} Sensor\n\n"
            f"**What the patch does.** Substitutes pin {SENSOR_PINS[target]} with a "
            f"software reading `T̂ = {intercept:.4f} + "
            f"{coefs[0]:.4f}·{basis[0]} + {coefs[1]:.4f}·{basis[1]}` — the OLS fit "
            f"computed against {len(window)} samples of pre-attack telemetry "
            f"(R²={r2:.3f}).\n\n"
            f"**Why it neutralizes the attack.** The injected EMI energy is "
            f"confined to the {target} jumper. The synthesized reading never "
            f"reads pin {SENSOR_PINS[target]} again — the attack surface is "
            f"removed at the firmware layer with no resoldering.\n\n"
            f"**Risk during flight.** Predictor variance is preserved on "
            f"{basis[0]}/{basis[1]}; if those degrade, the synthesised value "
            f"degrades gracefully toward the intercept rather than failing closed.\n\n"
            f"PATCH_READY"
        ),
        fallback_analysis="Local model unreachable; deterministic blue prose used",
        temperature=0.25,
        num_predict=500,
    )

    # Stage 2 — actual Arduino patch with the real coefficients.
    basis_coef_terms = " + ".join(f"{c:.5f}*{b}" for c, b in zip(coefs, basis))
    code_resp = await state.llm.generate_with_system_prompt(
        BLUE_CODE_PROMPT.format(
            target=target, intercept=intercept,
            basis_coef_terms=basis_coef_terms,
        ),
        "Emit the .ino sketch now.",
        fallback_code=_ino_patch_fallback(target, basis, intercept, coefs),
        fallback_analysis="Local model unreachable; deterministic Arduino patch used",
        temperature=0.15,
        num_predict=900,
    )

    state.last_blue_patch = {
        "target": target, "basis": basis,
        "intercept": intercept, "coefficients": coefs, "r2": r2,
        "prose": prose_resp.code, "code": code_resp.code,
        "used_fallback": prose_resp.used_fallback or code_resp.used_fallback,
    }
    await broadcast({
        "type": "blue_team_patch",
        "target": target, "basis": basis,
        "intercept": intercept, "coefficients": coefs, "r2": r2,
        "prose": prose_resp.code,
        "code": code_resp.code,
        "lang": "cpp",
        "used_fallback": state.last_blue_patch["used_fallback"],
        "timestamp": time.time(),
    })


# ── REST ──────────────────────────────────────────────────────────────────────
@app.get("/api/status")
async def get_status():
    return {
        "status": state.status,
        "anomaly_count": state.anomaly_count,
        "simulate_serial": SIMULATE_SERIAL,
        "simulate_flash": SIMULATE_FLASH,
        "force_fallback_llm": FORCE_FALLBACK_LLM,
        "last_patch_time": state.last_patch_time,
        "ollama_analysis_model": OLLAMA_ANALYSIS_MODEL,
        "ollama_coder_model": OLLAMA_CODER_MODEL,
    }


@app.post("/api/simulate/attack")
async def trigger_attack():
    if not isinstance(state.reader, SimulatedReader):
        return {"error": "Not in simulation mode"}
    state.reader.trigger_attack()
    return {"message": "EMI attack simulation engaged"}


@app.post("/api/simulate/clear")
async def clear_attack():
    if isinstance(state.reader, SimulatedReader):
        state.reader.clear_attack()
    return {"message": "Attack simulation cleared"}


@app.get("/api/patch/latest")
async def get_latest_patch():
    return {"code": state.last_patch_code, "timestamp": state.last_patch_time}


# ── WebSocket ─────────────────────────────────────────────────────────────────
@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    state.clients.add(ws)
    await ws.send_text(json.dumps({
        "type": "connected",
        "status": state.status,
        "anomaly_count": state.anomaly_count,
        "simulate_serial": SIMULATE_SERIAL,
        "simulate_flash": SIMULATE_FLASH,
        "force_fallback_llm": FORCE_FALLBACK_LLM,
    }))
    try:
        while True:
            msg = await ws.receive_text()
            try:
                cmd = json.loads(msg)
            except Exception:
                continue
            action = cmd.get("action")
            if action == "trigger_attack" and isinstance(state.reader, SimulatedReader):
                state.reader.trigger_attack()
                await ws.send_text(json.dumps({"type": "ack", "action": "trigger_attack"}))
            elif action == "clear_attack" and isinstance(state.reader, SimulatedReader):
                state.reader.clear_attack()
                await ws.send_text(json.dumps({"type": "ack", "action": "clear_attack"}))
            elif action == "start_harden":
                state.harden_active = True
                state.last_red_plan = None
                state.last_blue_patch = None
                if isinstance(state.reader, SimulatedReader):
                    state.reader.clear_attack()
                    state.reader.clear_virtual_sensor()
                state.detector.reset()
                await broadcast({"type": "harden_started", "timestamp": time.time()})
            elif action == "request_red_plan":
                asyncio.create_task(handle_red_plan())
                await ws.send_text(json.dumps({"type": "ack", "action": "request_red_plan"}))
            elif action == "launch_attack" and isinstance(state.reader, SimulatedReader):
                plan = state.last_red_plan or _heuristic_red_plan()
                spec = state.reader.trigger_attack(
                    target=plan["target"],
                    kind=plan["kind"],
                    magnitude=float(plan.get("magnitude", 1.0)),
                )
                state.status = "anomaly_detected"
                state.anomaly_count += 1
                await broadcast({
                    "type": "harden_attack_launched",
                    "target": spec.target,
                    "kind": spec.kind,
                    "magnitude": spec.magnitude,
                    "timestamp": time.time(),
                })
            elif action == "request_blue_patch":
                asyncio.create_task(handle_blue_patch())
                await ws.send_text(json.dumps({"type": "ack", "action": "request_blue_patch"}))
            elif action == "apply_patch":
                patch = state.last_blue_patch
                if isinstance(state.reader, SimulatedReader) and patch:
                    state.reader.apply_virtual_sensor(
                        target=patch["target"],
                        basis=patch["basis"],
                        intercept=patch["intercept"],
                        coefficients=patch["coefficients"],
                    )
                    # Keep the attacker active so the operator can see the
                    # virtual sensor genuinely overriding the spoofed channel.
                state.status = "patched"
                await broadcast({
                    "type": "harden_patch_applied",
                    "target": (patch or {}).get("target", "temperature"),
                    "intercept": (patch or {}).get("intercept"),
                    "coefficients": (patch or {}).get("coefficients"),
                    "basis": (patch or {}).get("basis"),
                    "timestamp": time.time(),
                })
            elif action == "exit_harden":
                state.harden_active = False
                state.status = "monitoring"
                if isinstance(state.reader, SimulatedReader):
                    state.reader.clear_attack()
                    state.reader.clear_virtual_sensor()
                state.detector.reset()
                state.last_red_plan = None
                state.last_blue_patch = None
                await broadcast({"type": "harden_exited", "timestamp": time.time()})
    except WebSocketDisconnect:
        pass
    finally:
        state.clients.discard(ws)


# ── Static models (mounted before frontend catch-all) ────────────────────────
if MODELS_DIR.exists():
    app.mount("/models", StaticFiles(directory=str(MODELS_DIR)), name="models")

# ── Static frontend (mounted last so /api and /ws win) ────────────────────────
if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
