import json
import re
import statistics
from dataclasses import dataclass

import httpx


SYSTEM_PROMPT = """You are an embedded systems security AI operating in an air-gapped environment.
Sensor tampering has been detected on an Arduino microcontroller.
Your job is to generate a firmware patch that virtualizes the compromised sensor.

RULES:
1. Output ONLY valid Arduino C++ code. No markdown. No backticks. No explanations.
2. The code must be a complete, compilable Arduino sketch (.ino).
3. Replace the compromised temperature sensor (Pin A0) with a virtual sensor.
4. Derive temperature from pressure (A1) and current (A2) using a linear regression
   model whose coefficients you fit from the provided historical telemetry.
5. Servo on Pin 9 should track the virtual temperature (map 20-30 deg C to 0-180).
6. Log "VIRTUAL_SENSOR_ACTIVE" to Serial at 9600 baud once per second.
"""

USER_PROMPT_TEMPLATE = """SECURITY ALERT: Temperature sensor on Pin A0 compromised by EMI spoofing.

Telemetry window (last {n} of {total} readings):
{telemetry_json}

Statistical summary:
- Temperature variance: {temp_var:.4f}  (FLATLINED — sensor compromised)
- Pressure variance:    {pres_var:.2f}  (NORMAL)
- Current variance:     {curr_var:.5f} (NORMAL)

Generate Arduino firmware that:
1. Deprecates the physical temperature sensor on Pin A0.
2. Implements: float virtualTemp(float pressure, float current)
3. Fits a linear regression from the historical data above.
4. Maintains servo output behavior using the virtual reading.
5. Emits "VIRTUAL_SENSOR_ACTIVE" to Serial at 9600 baud at 1 Hz.

Output ONLY the .ino code. No other text."""


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


@dataclass
class LLMResponse:
    code: str
    analysis: str
    raw: str
    used_fallback: bool


class LLMClient:
    """Local Ollama client. Falls back to a deterministic patch if Ollama is unreachable."""

    def __init__(
        self,
        base_url: str = "http://localhost:11434",
        model: str = "llama3.1",
        timeout: float = 120.0,
        force_fallback: bool = False,
    ):
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.timeout = timeout
        self.force_fallback = force_fallback

    async def generate_patch(self, telemetry_window: list) -> LLMResponse:
        if self.force_fallback:
            return LLMResponse(
                code=FALLBACK_PATCH,
                analysis="Demo mode — using deterministic fallback patch",
                raw=FALLBACK_PATCH,
                used_fallback=True,
            )

        temps = [r["temperature"] for r in telemetry_window]
        press = [r["pressure"] for r in telemetry_window]
        curs = [r["current"] for r in telemetry_window]

        prompt = USER_PROMPT_TEMPLATE.format(
            n=min(10, len(telemetry_window)),
            total=len(telemetry_window),
            telemetry_json=json.dumps(telemetry_window[-10:], indent=2),
            temp_var=statistics.variance(temps) if len(temps) > 1 else 0.0,
            pres_var=statistics.variance(press) if len(press) > 1 else 0.0,
            curr_var=statistics.variance(curs) if len(curs) > 1 else 0.0,
        )

        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                resp = await client.post(
                    f"{self.base_url}/api/generate",
                    json={
                        "model": self.model,
                        "prompt": prompt,
                        "system": SYSTEM_PROMPT,
                        "stream": False,
                        "options": {"temperature": 0.1, "num_predict": 2048},
                    },
                )
                resp.raise_for_status()
                data = resp.json()
            raw = data.get("response", "")
            code = re.sub(r"```(?:cpp|arduino|c\+\+|c)?", "", raw).replace("```", "").strip()
            if not code:
                raise ValueError("Empty LLM response")
            return LLMResponse(
                code=code,
                analysis=f"Patch generated by {self.model}",
                raw=raw,
                used_fallback=False,
            )
        except Exception as e:
            return LLMResponse(
                code=FALLBACK_PATCH,
                analysis=f"Ollama unreachable ({e}); using fallback patch",
                raw=str(e),
                used_fallback=True,
            )
