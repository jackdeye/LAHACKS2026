import asyncio
import json
import math
import random
import time
from dataclasses import dataclass
from typing import Optional


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


class SimulatedReader:
    """Simulates Arduino sensor data for dev/demo. Supports EMI attack injection."""

    def __init__(self):
        self._start = time.time()
        self._attack_active = False
        self._base_temp = 24.5
        self._base_pressure = 1013.2
        self._base_current = 0.85

    def trigger_attack(self):
        self._attack_active = True

    def clear_attack(self):
        self._attack_active = False

    @property
    def attack_active(self) -> bool:
        return self._attack_active

    async def read_next(self) -> SensorReading:
        await asyncio.sleep(0.1)  # 10 Hz
        elapsed = time.time() - self._start

        pressure = self._base_pressure + 5 * math.sin(elapsed * 0.3) + random.gauss(0, 0.8)
        current = self._base_current + 0.1 * math.sin(elapsed * 0.7) + random.gauss(0, 0.02)

        if self._attack_active:
            # EMI attack: ADC reads constant "safe" max voltage — temperature flatlines
            temperature = self._base_temp + random.gauss(0, 0.008)
        else:
            temperature = self._base_temp + 1.5 * math.sin(elapsed * 0.2) + random.gauss(0, 0.3)

        # Synthesise plausible values for the auxiliary channels so the dashboard
        # has something to show in simulation mode.
        humidity = 45 + 3 * math.sin(elapsed * 0.15) + random.gauss(0, 0.4)
        light = 600 + 80 * math.sin(elapsed * 0.4) + random.gauss(0, 8)
        fan = 100 + 5 * math.sin(elapsed * 0.5)
        alarm = 1 if self._attack_active else 0

        return SensorReading(
            timestamp=time.time(),
            temperature=round(temperature, 2),
            pressure=round(pressure, 2),
            current=round(current, 3),
            humidity=round(humidity, 1),
            light=round(light, 0),
            fan=round(fan, 0),
            alarm=alarm,
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
