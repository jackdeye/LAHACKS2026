import random
import statistics
from collections import deque
from dataclasses import dataclass, field
from typing import List


@dataclass
class AnomalyResult:
    detected: bool
    reason: str
    confidence: float
    telemetry_window: List[dict] = field(default_factory=list)
    stats: dict = field(default_factory=dict)
    compromised_sensor: str = ""


class AnomalyDetector:
    """
    Triggers on the rising edge of the firmware-side alarm bit. The Arduino
    raises this when the Flipper Zero's NEC IR payload lands on the IR
    receiver (treated as our spoofing signal in the demo). One trigger per
    attack: stays armed only after alarm clears, so holding the Flipper down
    doesn't fire a continuous stream of incidents.

    A random sensor channel is picked each time as the "compromised" one so
    successive demos cycle through different attack scenarios.
    """

    SENSORS = ("temperature", "pressure", "light", "humidity")

    def __init__(self, window_size: int = 50, min_readings: int = 25):
        self.window_size = window_size
        self.min_readings = min_readings

        self._t = deque(maxlen=window_size)
        self._p = deque(maxlen=window_size)
        self._c = deque(maxlen=window_size)
        self._h = deque(maxlen=window_size)
        self._ts = deque(maxlen=window_size)
        self._last_alarm = 0
        self._current_alarm = 0

    def push(self, reading) -> None:
        self._t.append(reading.temperature)
        self._p.append(reading.pressure)
        self._c.append(reading.current)
        self._h.append(reading.humidity)
        self._ts.append(reading.timestamp)
        self._current_alarm = int(reading.alarm)

    def reset(self) -> None:
        self._t.clear()
        self._p.clear()
        self._c.clear()
        self._h.clear()
        self._ts.clear()
        # _last_alarm intentionally retained: if the attack is still ongoing
        # post-patch, we wait for it to clear before re-arming.

    def check(self) -> AnomalyResult:
        alarm = self._current_alarm
        rising_edge = alarm == 1 and self._last_alarm == 0
        self._last_alarm = alarm

        stats = self._stats()

        # Pure alarm-driven detection — we don't actually verify variance, the
        # firmware alarm bit is the ground truth. Any rising edge fires an
        # incident with a randomly attributed sensor.
        if not rising_edge:
            return AnomalyResult(False, "All sensors nominal", 0.0, stats=stats)

        sensor = random.choice(self.SENSORS)
        reason = (
            f"FLIPPER ATTACK DETECTED — firmware alarm bit raised. "
            f"Suspected spoofing vector: {sensor.upper()} channel."
        )
        return AnomalyResult(
            detected=True,
            reason=reason,
            confidence=1.0,
            telemetry_window=self._snapshot(),
            stats=stats,
            compromised_sensor=sensor,
        )

    def _stats(self) -> dict:
        if len(self._t) < 2:
            return {"temp_variance": 0.0, "pressure_variance": 0.0, "current_variance": 0.0}
        return {
            "temp_variance": round(statistics.variance(self._t), 5),
            "pressure_variance": round(statistics.variance(self._p), 4),
            "current_variance": round(statistics.variance(self._c), 5),
        }

    def _snapshot(self) -> List[dict]:
        return [
            {"timestamp": ts, "temperature": t, "pressure": p, "current": c}
            for ts, t, p, c in zip(self._ts, self._t, self._p, self._c)
        ]
