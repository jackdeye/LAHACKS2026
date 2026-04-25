import asyncio
import os
import shutil
import tempfile
from dataclasses import dataclass


@dataclass
class FlashResult:
    success: bool
    message: str
    output: str


class FlashManager:
    """Compiles and flashes Arduino firmware via arduino-cli, or simulates it."""

    def __init__(
        self,
        port: str = "/dev/ttyUSB0",
        fqbn: str = "arduino:avr:uno",
        simulate: bool = True,
    ):
        self.port = port
        self.fqbn = fqbn
        self.simulate = simulate

    async def flash(self, code: str, sketch_name: str = "aegis_patch") -> FlashResult:
        if self.simulate:
            return await self._simulated_flash(code)
        return await self._real_flash(code, sketch_name)

    async def _simulated_flash(self, code: str) -> FlashResult:
        await asyncio.sleep(1.4)  # compile
        await asyncio.sleep(0.6)  # upload
        size = len(code.encode())
        return FlashResult(
            success=True,
            message="[SIMULATED] Firmware compiled and flashed successfully",
            output=(
                f"Sketch source: {size} bytes\n"
                f"Sketch uses 5,234 bytes (16%) of program storage space\n"
                f"Global variables use 312 bytes (15%) of dynamic memory\n"
                f"avrdude: 5234 bytes of flash written\n"
                f"avrdude: verifying flash memory against patch.hex\n"
                f"avrdude done.  Thank you."
            ),
        )

    async def _real_flash(self, code: str, sketch_name: str) -> FlashResult:
        sketch_dir = tempfile.mkdtemp(prefix=f"aegis_{sketch_name}_")
        sketch_subdir = os.path.join(sketch_dir, sketch_name)
        os.makedirs(sketch_subdir, exist_ok=True)
        sketch_file = os.path.join(sketch_subdir, f"{sketch_name}.ino")

        try:
            with open(sketch_file, "w") as f:
                f.write(code)

            compile_proc = await asyncio.create_subprocess_exec(
                "arduino-cli", "compile", "--fqbn", self.fqbn, sketch_subdir,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
            )
            compile_out, _ = await compile_proc.communicate()
            if compile_proc.returncode != 0:
                return FlashResult(False, "Compilation failed", compile_out.decode(errors="replace"))

            upload_proc = await asyncio.create_subprocess_exec(
                "arduino-cli", "upload",
                "--fqbn", self.fqbn,
                "--port", self.port,
                sketch_subdir,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
            )
            upload_out, _ = await upload_proc.communicate()
            success = upload_proc.returncode == 0
            return FlashResult(
                success=success,
                message="Firmware flashed successfully" if success else "Upload failed",
                output=(compile_out + b"\n" + upload_out).decode(errors="replace"),
            )
        finally:
            shutil.rmtree(sketch_dir, ignore_errors=True)
