import asyncio
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
    current: float


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

        return SensorReading(
            timestamp=time.time(),
            temperature=round(temperature, 2),
            pressure=round(pressure, 2),
            current=round(current, 3),
        )


class SerialReader:
    """Reads CSV telemetry from Arduino via serial port.
    Arduino should output: TEMP:24.5,PRES:1013.2,CURR:0.85\\n
    """

    def __init__(self, port: str = "/dev/ttyUSB0", baud: int = 115200):
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
        line = await self._reader.readline()
        parts = line.decode().strip().split(",")
        data = {}
        for part in parts:
            k, v = part.split(":")
            data[k] = float(v)
        return SensorReading(
            timestamp=time.time(),
            temperature=data["TEMP"],
            pressure=data["PRES"],
            current=data["CURR"],
        )
