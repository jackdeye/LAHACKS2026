import asyncio
import json
import math
import random
import time
from dataclasses import dataclass, field
from typing import Optional


SensorKey = str  # "temperature" | "pressure" | "current"
ATTACK_KINDS = ("flatline", "spike", "drift")


@dataclass
class SensorReading:
    timestamp: float
    temperature: float
    pressure: float
    current: float          # third primary channel (light value when on hardware)
    humidity: float = 0.0
    light: float = 0.0
    fan: float = 0.0
    alarm: int = 0

    def get(self, key: str) -> float:
        return getattr(self, key)


@dataclass
class AttackSpec:
    target: SensorKey
    kind: str            # "flatline" | "spike" | "drift"
    magnitude: float = 1.0
    started_at: float = 0.0
    pinned_value: float = 0.0  # snapshot at attack start, used for flatline / spike base


@dataclass
class VirtualSensor:
    """When applied, the patched channel's value is replaced by
    intercept + sum(coefficients[i] * reading.get(basis[i]))."""
    target: SensorKey
    basis: list           # e.g. ["pressure", "current"]
    intercept: float
    coefficients: list    # same length as basis


class SimulatedReader:
    """Simulates Arduino sensor data. Attacks are parameterised and the virtual-
    sensor patch genuinely substitutes a fitted regression at read time."""

    def __init__(self):
        self._start = time.time()
        self._base_temp = 24.5
        self._base_pressure = 1013.2
        self._base_current = 0.85
        self._attack: Optional[AttackSpec] = None
        self._virtual: Optional[VirtualSensor] = None

    # ── Attack control ──
    def trigger_attack(self, target: SensorKey = "temperature",
                       kind: str = "flatline",
                       magnitude: float = 1.0) -> AttackSpec:
        if kind not in ATTACK_KINDS:
            kind = "flatline"
        if target not in ("temperature", "pressure", "current"):
            target = "temperature"
        # snapshot the natural value at attack start so flatline pins to a
        # plausible reading rather than the sensor base.
        natural = self._natural_reading(time.time() - self._start)
        spec = AttackSpec(
            target=target,
            kind=kind,
            magnitude=magnitude,
            started_at=time.time(),
            pinned_value=natural.get(target),
        )
        self._attack = spec
        return spec

    def clear_attack(self) -> None:
        self._attack = None

    @property
    def attack(self) -> Optional[AttackSpec]:
        return self._attack

    @property
    def attack_active(self) -> bool:
        return self._attack is not None

    # ── Virtual-sensor patch ──
    def apply_virtual_sensor(self, target: SensorKey,
                             basis: list,
                             intercept: float,
                             coefficients: list) -> VirtualSensor:
        v = VirtualSensor(target=target, basis=list(basis),
                          intercept=float(intercept),
                          coefficients=[float(c) for c in coefficients])
        self._virtual = v
        return v

    def clear_virtual_sensor(self) -> None:
        self._virtual = None

    @property
    def virtual_sensor(self) -> Optional[VirtualSensor]:
        return self._virtual

    # ── Reading loop ──
    def _natural_reading(self, elapsed: float) -> SensorReading:
        # Auxiliary channels (humidity / light / fan / alarm) are synthesised so
        # the simulator stays interface-compatible with the on-hardware reader.
        return SensorReading(
            timestamp=time.time(),
            temperature=self._base_temp + 1.5 * math.sin(elapsed * 0.2) + random.gauss(0, 0.3),
            pressure=self._base_pressure + 5 * math.sin(elapsed * 0.3) + random.gauss(0, 0.8),
            current=self._base_current + 0.1 * math.sin(elapsed * 0.7) + random.gauss(0, 0.02),
            humidity=45 + 3 * math.sin(elapsed * 0.15) + random.gauss(0, 0.4),
            light=600 + 80 * math.sin(elapsed * 0.4) + random.gauss(0, 8),
            fan=100 + 5 * math.sin(elapsed * 0.5),
            alarm=0,
        )

    def _apply_attack(self, reading: SensorReading, elapsed_since_attack: float) -> SensorReading:
        if not self._attack:
            return reading
        a = self._attack
        natural = reading.get(a.target)
        if a.kind == "flatline":
            # ADC pinned at the value at attack start; tiny noise floor.
            new = a.pinned_value + random.gauss(0, 0.01 * a.magnitude)
        elif a.kind == "spike":
            # Sharp periodic spikes superimposed on the natural signal.
            spike = a.magnitude * 4.0 * math.sin(elapsed_since_attack * 6.0)
            new = natural + spike + random.gauss(0, 0.05)
        elif a.kind == "drift":
            # Linear drift away from the legitimate value.
            new = natural + a.magnitude * 0.6 * elapsed_since_attack
        else:
            new = natural
        return self._with(reading, a.target, new)

    def _apply_virtual(self, reading: SensorReading) -> SensorReading:
        v = self._virtual
        if not v:
            return reading
        synthesized = v.intercept
        for coef, key in zip(v.coefficients, v.basis):
            synthesized += coef * reading.get(key)
        return self._with(reading, v.target, synthesized)

    @staticmethod
    def _with(r: SensorReading, key: SensorKey, value: float) -> SensorReading:
        # Preserve auxiliary channels when only one of the primary three is being
        # rewritten (by attack injection or virtual-sensor synthesis).
        return SensorReading(
            timestamp=r.timestamp,
            temperature=value if key == "temperature" else r.temperature,
            pressure=value if key == "pressure" else r.pressure,
            current=value if key == "current" else r.current,
            humidity=r.humidity,
            light=r.light,
            fan=r.fan,
            alarm=r.alarm,
        )

    async def read_next(self) -> SensorReading:
        await asyncio.sleep(0.1)  # 10 Hz
        elapsed = time.time() - self._start
        reading = self._natural_reading(elapsed)
        if self._attack:
            reading = self._apply_attack(reading, time.time() - self._attack.started_at)
        # Virtual sensor runs AFTER attack — that's the whole point: it heals the
        # spoofed channel by recomputing it from the surviving sensors.
        if self._virtual:
            reading = self._apply_virtual(reading)
        return SensorReading(
            timestamp=time.time(),
            temperature=round(reading.temperature, 3),
            pressure=round(reading.pressure, 3),
            current=round(reading.current, 4),
            humidity=round(reading.humidity, 1),
            light=round(reading.light, 0),
            fan=round(reading.fan, 0),
            alarm=1 if self._attack else 0,
        )


class SerialReader:
    """Reads JSON telemetry from Arduino via serial port.

    Arduino should emit one JSON object per line, e.g.:
      {"t":1629,"temp_c":22.4,"hum":44.5,"press":110,"light":0,"fan":107,"alarm":0}
    Lines that aren't valid JSON (boot banners, debug prints) are silently
    skipped so a noisy serial stream doesn't crash the telemetry loop.
    """

    def __init__(self, port: str = "/dev/ttyACM0", baud: int = 115200):
        self.port = port
        self.baud = baud
        self._reader = None

    async def connect(self):
        import serial_asyncio  # type: ignore
        self._reader, _ = await serial_asyncio.open_serial_connection(
            url=self.port, baudrate=self.baud
        )

    async def read_next(self) -> SensorReading:
        if self._reader is None:
            await self.connect()
        while True:
            raw = await self._reader.readline()
            line = raw.decode(errors="replace").strip()
            if not line.startswith("{"):
                continue
            try:
                data = json.loads(line)
            except json.JSONDecodeError:
                continue
            try:
                temp_c = float(data["temp_c"])
                press = float(data["press"])
                light = float(data["light"])
            except (KeyError, ValueError, TypeError):
                continue
            return SensorReading(
                timestamp=time.time(),
                temperature=temp_c,
                pressure=press,
                current=light,
                humidity=float(data.get("hum", 0.0)),
                light=light,
                fan=float(data.get("fan", 0.0)),
                alarm=int(data.get("alarm", 0)),
            )
