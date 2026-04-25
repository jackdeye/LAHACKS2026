import asyncio
import json
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Set

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from anomaly_detector import AnomalyDetector
from flash_manager import FlashManager
from llm_client import LLMClient
from serial_reader import SerialReader, SimulatedReader

# ── Configuration ─────────────────────────────────────────────────────────────
SIMULATE_SERIAL = os.getenv("SIMULATE_SERIAL", "true").lower() == "true"
SIMULATE_FLASH = os.getenv("SIMULATE_FLASH", "true").lower() == "true"
FORCE_FALLBACK_LLM = os.getenv("FORCE_FALLBACK_LLM", "true").lower() == "true"
SERIAL_PORT = os.getenv("SERIAL_PORT", "/dev/ttyUSB0")
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://localhost:11434")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "llama3.1")

FRONTEND_DIR = Path(__file__).parent.parent / "frontend"


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
        self.llm = LLMClient(base_url=OLLAMA_URL, model=OLLAMA_MODEL, force_fallback=FORCE_FALLBACK_LLM)
        self.flash_mgr = FlashManager(port=SERIAL_PORT, simulate=SIMULATE_FLASH)
        self.processing = False


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
                },
                "anomaly": result.detected,
                "anomaly_confidence": result.confidence,
                "stats": result.stats,
                "status": state.status,
            })

            if result.detected and not state.processing:
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
        "ollama_model": OLLAMA_MODEL,
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
    except WebSocketDisconnect:
        pass
    finally:
        state.clients.discard(ws)


# ── Static frontend (mounted last so /api and /ws win) ────────────────────────
if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
