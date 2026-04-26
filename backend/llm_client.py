import json
import re
import statistics
from dataclasses import dataclass

import httpx


# ── Stage 1: analyst (llama 3.1 70B) ──────────────────────────────────────────
ANALYST_SYSTEM = """You are an embedded-systems security analyst working in an
air-gapped SOC for networked medical hardware. You inspect short telemetry
windows from an Arduino-controlled device and identify sensor-tampering
signatures (EMI flatlining, replay attacks, biased ADC reads). You do NOT
write code.

Output a tight remediation brief: 3–5 short paragraphs (or terse bullets),
total under 180 words. Cover, in order:
  1. The attack signature you see in the data.
  2. Which physical sensor is compromised and why you're confident.
  3. The mitigation strategy (virtual sensor synthesised from correlated
     channels — name the channels and how they relate to the missing one).
  4. Any caveats the coder should account for (saturation, units, drift).

No markdown headers. No code blocks. Plain prose."""

ANALYST_USER_TEMPLATE = """Telemetry window (last {n} of {total} readings):
{telemetry_json}

Statistical summary:
- Temperature variance: {temp_var:.4f}  (FLATLINED if near zero)
- Pressure variance:    {pres_var:.2f}
- Current variance:     {curr_var:.5f}

Suspected compromised channel (from on-device alarm + correlation): {compromised_sensor}

Produce the remediation brief."""


# ── Stage 2: coder (qwen-coder) ───────────────────────────────────────────────
CODER_SYSTEM = """You are an embedded firmware engineer. Given a security
analyst's brief and a telemetry window, you synthesise an Arduino C++ patch
that virtualises the compromised sensor.

RULES:
1. Output ONLY a complete, compilable Arduino sketch (.ino). No markdown. No
   backticks. No prose. No explanations. Just the .ino source.
2. Replace the compromised temperature sensor (Pin A0) with a virtual sensor.
3. Derive temperature from pressure (A1) and current (A2) using a linear
   regression model whose coefficients you fit from the provided telemetry.
4. Servo on Pin 9 should track the virtual temperature (map 20-30 °C → 0-180).
5. Log "VIRTUAL_SENSOR_ACTIVE" to Serial at 9600 baud once per second."""

CODER_USER_TEMPLATE = """Analyst remediation brief:
{analysis}

Telemetry window (last {n} of {total} readings):
{telemetry_json}

Generate the .ino patch per your system rules. Output the code only."""


FALLBACK_PATCH = """// AEGIS EDGE — Auto-generated virtual sensor patch
// Deprecates compromised temperature sensor on A0; derives virtual reading
// from pressure (A1) and current (A2) via linear regression.

#include <Servo.h>

const int PIN_PRESSURE = A1;
const int PIN_CURRENT  = A2;
const int PIN_SERVO    = 9;
const int PIN_LED      = 13;

// Linear regression coefficients fit from pre-attack telemetry window.
// virtualTemp = b0 + b1*pressure + b2*current
const float B0 = 18.4231f;
const float B1 = 0.00612f;
const float B2 = -0.18034f;

Servo healthServo;
unsigned long lastLog = 0;

float readPressure() {
  return analogRead(PIN_PRESSURE) * (1023.0 / 1023.0) * 0.1 + 1010.0;
}

float readCurrent() {
  return analogRead(PIN_CURRENT) * (5.0 / 1023.0) * 0.2;
}

float virtualTemp(float pressure, float current) {
  return B0 + B1 * pressure + B2 * current;
}

void setup() {
  Serial.begin(9600);
  pinMode(PIN_LED, OUTPUT);
  healthServo.attach(PIN_SERVO);
  Serial.println("AEGIS PATCH LOADED");
}

void loop() {
  float p = readPressure();
  float c = readCurrent();
  float t = virtualTemp(p, c);

  int angle = constrain(map((int)(t * 10), 200, 300, 0, 180), 0, 180);
  healthServo.write(angle);
  digitalWrite(PIN_LED, HIGH);

  if (millis() - lastLog > 1000) {
    lastLog = millis();
    Serial.print("VIRTUAL_SENSOR_ACTIVE T=");
    Serial.print(t);
    Serial.print(" P=");
    Serial.print(p);
    Serial.print(" I=");
    Serial.println(c);
  }
  delay(50);
}
"""


FALLBACK_ANALYSIS = (
    "Temperature channel variance has collapsed below the variance floor while "
    "pressure and current continue to oscillate within nominal envelopes — "
    "consistent with an EMI injection pinning the A0 ADC to a constant rail. "
    "Mitigation: deprecate the compromised pin and synthesise temperature from "
    "the still-trustworthy pressure (A1) and current (A2) channels via a linear "
    "regression fit from the pre-attack window."
)


@dataclass
class LLMResponse:
    code: str
    analysis: str
    raw: str
    used_fallback: bool


class LLMClient:
    """Two-stage local Ollama client.

    Stage 1 (analyst, e.g. llama3.1:70b) reads the telemetry and produces a
    remediation brief in natural language. Stage 2 (coder, e.g. qwen2.5-coder)
    receives that brief alongside the telemetry and synthesises the Arduino
    .ino patch. Either stage failing falls the whole call back to a
    deterministic patch + canned analysis so the dashboard pipeline keeps
    flowing.
    """

    def __init__(
        self,
        base_url: str = "http://localhost:11434",
        analysis_model: str = "llama3.1:70b",
        coder_model: str = "qwen2.5-coder",
        timeout: float = 300.0,
        force_fallback: bool = False,
    ):
        self.base_url = base_url.rstrip("/")
        self.analysis_model = analysis_model
        self.coder_model = coder_model
        self.timeout = timeout
        self.force_fallback = force_fallback

    async def _ollama(
        self,
        client: httpx.AsyncClient,
        model: str,
        system: str,
        prompt: str,
        num_predict: int,
        temperature: float = 0.1,
        format: str | None = None,
    ) -> str:
        payload: dict = {
            "model": model,
            "prompt": prompt,
            "system": system,
            "stream": False,
            "options": {"temperature": temperature, "num_predict": num_predict},
        }
        if format:
            payload["format"] = format
        resp = await client.post(f"{self.base_url}/api/generate", json=payload)
        resp.raise_for_status()
        return resp.json().get("response", "")

    @staticmethod
    def _stats(window: list) -> dict:
        if len(window) < 2:
            return {"temp_var": 0.0, "pres_var": 0.0, "curr_var": 0.0}
        return {
            "temp_var": statistics.variance([r["temperature"] for r in window]),
            "pres_var": statistics.variance([r["pressure"] for r in window]),
            "curr_var": statistics.variance([r["current"] for r in window]),
        }

    async def generate_json(
        self,
        system_prompt: str,
        user_prompt: str,
        *,
        required_keys: list,
        fallback: dict,
        model: str | None = None,
        temperature: float = 0.2,
        num_predict: int = 400,
    ) -> dict:
        """Ask the model for JSON. Extract from a fenced or raw response, validate
        that all required keys are present, return the fallback dict on any error.
        Defaults to the analyst model — JSON planning is a reasoning task."""
        if self.force_fallback:
            return {**fallback, "_used_fallback": True}
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                raw = await self._ollama(
                    client,
                    model or self.analysis_model,
                    system_prompt,
                    user_prompt,
                    num_predict=num_predict,
                    temperature=temperature,
                    format="json",
                )
            stripped = re.sub(r"```(?:json)?", "", raw).replace("```", "").strip()
            start = stripped.find("{")
            end = stripped.rfind("}")
            if start == -1 or end == -1 or end <= start:
                raise ValueError(f"No JSON object in response: {raw[:120]!r}")
            obj = json.loads(stripped[start : end + 1])
            for key in required_keys:
                if key not in obj:
                    raise ValueError(f"Missing key {key!r} in {list(obj)}")
            obj["_used_fallback"] = False
            return obj
        except Exception as e:
            return {**fallback, "_used_fallback": True, "_error": str(e)}

    async def generate_with_system_prompt(
        self,
        system_prompt: str,
        user_prompt: str,
        *,
        fallback_code: str = "",
        fallback_analysis: str = "Local model unreachable",
        model: str | None = None,
        temperature: float = 0.1,
        num_predict: int = 2048,
    ) -> LLMResponse:
        """Single-call helper around Ollama. Returns the fallback values on any
        error. Defaults to the analyst model; callers wanting a code-shaped
        response should pass `model=self.coder_model` explicitly."""
        chosen = model or self.analysis_model
        if self.force_fallback:
            return LLMResponse(
                code=fallback_code,
                analysis="Demo mode — using deterministic fallback",
                raw=fallback_code,
                used_fallback=True,
            )
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                raw = await self._ollama(
                    client, chosen, system_prompt, user_prompt,
                    num_predict=num_predict, temperature=temperature,
                )
            stripped = re.sub(r"```(?:cpp|arduino|c\+\+|c|ino|python|py|markdown|md)?", "", raw).replace("```", "").strip()
            if not stripped:
                raise ValueError("Empty LLM response")
            return LLMResponse(
                code=stripped,
                analysis=f"Generated by {chosen}",
                raw=raw,
                used_fallback=False,
            )
        except Exception as e:
            return LLMResponse(
                code=fallback_code,
                analysis=f"{fallback_analysis} ({e})",
                raw=str(e),
                used_fallback=True,
            )

    async def generate_patch(
        self,
        telemetry_window: list,
        compromised_sensor: str = "temperature",
    ) -> LLMResponse:
        if self.force_fallback:
            return LLMResponse(
                code=FALLBACK_PATCH,
                analysis="Demo mode — using deterministic fallback patch",
                raw=FALLBACK_PATCH,
                used_fallback=True,
            )

        s = self._stats(telemetry_window)
        recent = telemetry_window[-10:]
        telemetry_json = json.dumps(recent, indent=2)
        n = len(recent)
        total = len(telemetry_window)

        analyst_prompt = ANALYST_USER_TEMPLATE.format(
            n=n, total=total,
            telemetry_json=telemetry_json,
            temp_var=s["temp_var"], pres_var=s["pres_var"], curr_var=s["curr_var"],
            compromised_sensor=compromised_sensor or "temperature",
        )

        # No silent fallback: errors propagate so the dashboard reports the
        # local model as unreachable instead of pretending a patch was synthesised.
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            analysis_raw = await self._ollama(
                client, self.analysis_model, ANALYST_SYSTEM, analyst_prompt,
                num_predict=512,
            )
            analysis = analysis_raw.strip()
            if not analysis:
                raise RuntimeError("Empty response from analyst model")

            coder_prompt = CODER_USER_TEMPLATE.format(
                analysis=analysis,
                n=n, total=total,
                telemetry_json=telemetry_json,
            )
            code_raw = await self._ollama(
                client, self.coder_model, CODER_SYSTEM, coder_prompt,
                num_predict=2048,
            )

        code = re.sub(r"```(?:cpp|arduino|c\+\+|c|ino)?", "", code_raw)
        code = code.replace("```", "").strip()
        if not code:
            raise RuntimeError("Empty response from coder model")

        return LLMResponse(
            code=code,
            analysis=analysis,
            raw=f"[analyst]\n{analysis_raw}\n\n[coder]\n{code_raw}",
            used_fallback=False,
        )
