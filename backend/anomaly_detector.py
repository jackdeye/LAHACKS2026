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


class AnomalyDetector:
    """
    Detects sensor spoofing via statistical analysis of a rolling window.

    Primary signature (EMI attack on temperature pin):
      Temperature variance collapses to ~0 (ADC pinned at constant voltage)
      while correlated sensors (pressure, current) continue to vary normally.
    """

    def __init__(
        self,
        window_size: int = 50,
        temp_var_threshold: float = 0.05,
        pressure_var_threshold: float = 1.0,
        min_readings: int = 25,
    ):
        self.window_size = window_size
        self.temp_var_threshold = temp_var_threshold
        self.pressure_var_threshold = pressure_var_threshold
        self.min_readings = min_readings

        self._t = deque(maxlen=window_size)
        self._p = deque(maxlen=window_size)
        self._c = deque(maxlen=window_size)
        self._ts = deque(maxlen=window_size)

    def push(self, reading) -> None:
        self._t.append(reading.temperature)
        self._p.append(reading.pressure)
        self._c.append(reading.current)
        self._ts.append(reading.timestamp)

    def reset(self) -> None:
        self._t.clear()
        self._p.clear()
        self._c.clear()
        self._ts.clear()

    def check(self) -> AnomalyResult:
        if len(self._t) < self.min_readings:
            return AnomalyResult(False, "Collecting baseline data", 0.0)

        temp_var = statistics.variance(self._t)
        pres_var = statistics.variance(self._p)
        curr_var = statistics.variance(self._c)

        stats = {
            "temp_variance": round(temp_var, 5),
            "pressure_variance": round(pres_var, 4),
            "current_variance": round(curr_var, 5),
        }

        temp_flatlined = temp_var < self.temp_var_threshold
        pressure_active = pres_var > self.pressure_var_threshold

        if temp_flatlined and pressure_active:
            confidence = min(1.0, pres_var / (self.pressure_var_threshold * 5))
            reason = (
                f"SENSOR SPOOFING DETECTED — temperature variance {temp_var:.4f} "
                f"below threshold {self.temp_var_threshold} while pressure variance "
                f"{pres_var:.2f} remains active. EMI attack signature confirmed."
            )
            return AnomalyResult(
                detected=True,
                reason=reason,
                confidence=confidence,
                telemetry_window=self._snapshot(),
                stats=stats,
            )

        return AnomalyResult(False, "All sensors nominal", 0.0, stats=stats)

    def _snapshot(self) -> List[dict]:
        return [
            {
                "timestamp": ts,
                "temperature": t,
                "pressure": p,
                "current": c,
            }
            for ts, t, p, c in zip(self._ts, self._t, self._p, self._c)
        ]
