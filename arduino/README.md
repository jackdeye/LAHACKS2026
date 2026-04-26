# Arduino — Aegis Edge Ventilator

Firmware for the ELEGOO UNO R3 that streams Temperature / Pressure / Fan-PWM
telemetry as JSON over USB serial. Hardware wiring is in `CIRCUIT.md`.

## Layout

```
arduino/
├── shell.nix             # FHS env with arduino-cli + avrdude
├── CIRCUIT.md            # bill of materials, pin map, wiring
├── README.md             # this file
└── ventilator/
    └── ventilator.ino    # the sketch
```

## Prerequisites

- Nix (the `shell.nix` builds an FHS env so arduino-cli's prebuilt AVR
  toolchain can find `/lib/ld-linux*`).
- An Arduino UNO R3 plugged in. It should enumerate as `/dev/ttyACM0`.
- udev rule + group membership so non-root can write to `/dev/ttyACM0`.
  On NixOS:
  ```nix
  services.udev.extraRules = ''
    SUBSYSTEM=="tty", ATTRS{idVendor}=="2341", GROUP="dialout", MODE="0660"
    SUBSYSTEM=="tty", ATTRS{idVendor}=="1a86", GROUP="dialout", MODE="0660"
  '';
  users.users.<you>.extraGroups = [ "dialout" ];
  ```
  Re-plug the board after `nixos-rebuild switch`.

## One-time setup

Enter the FHS shell from this directory:

```sh
nix-shell
```

Install the AVR core and the libraries the sketch uses:

```sh
arduino-cli core install arduino:avr
arduino-cli lib install "DHT sensor library" "Adafruit Unified Sensor" LiquidCrystal IRremote
```

### Fix executable bits (NixOS-only quirk)

`arduino-cli` downloads prebuilt ELF binaries (discovery, avrdude, avr-gcc,
ctags…) into `~/.arduino15/packages/`. On NixOS those land **without** the
`+x` bit, so any compile/upload fails with `permission denied`. Run this
once after any `arduino-cli core install` or `lib install`:

```sh
find ~/.arduino15/packages -path '*/tools/*' -type f ! -perm -u+x \
  -exec chmod +x {} +
```

## Build

```sh
arduino-cli compile --fqbn arduino:avr:uno ventilator
```

Expected output ends with the size summary, e.g.
`Sketch uses 7562 bytes (23%) of program storage space.`

## Flash

```sh
arduino-cli upload --fqbn arduino:avr:uno --port /dev/ttyACM0 ventilator
```

A successful upload prints `New upload port: /dev/ttyACM0 (serial)` and
exits 0. The board resets and the sketch starts running immediately.

### One-shot (build + flash)

```sh
arduino-cli compile --fqbn arduino:avr:uno --upload --port /dev/ttyACM0 ventilator
```

## Watch the telemetry

Reading the serial port from **inside** the bwrap FHS sandbox returns 0 bytes
— bwrap doesn't pass the tty through. Open a second terminal **outside**
`nix-shell`:

```sh
stty -F /dev/ttyACM0 115200 cs8 -cstopb -parenb -ixon raw -echo
cat /dev/ttyACM0
```

You should see one JSON line per ~100 ms:

```json
{"t":1524,"temp_c":22.3,"hum":41.0,"press":518,"fan":173,"alarm":0}
```

Field reference:

| field   | type   | meaning |
| :------ | :----- | :------ |
| `t`     | uint32 | board uptime, ms |
| `temp_c`| float  | DHT11 temperature, °C (0.0 if no sensor) |
| `hum`   | float  | DHT11 relative humidity, %  |
| `press` | int    | airway pressure, raw 10-bit ADC (0–1023) |
| `fan`   | int    | blower duty cycle, 0–255 |
| `alarm` | 0\|1   | over-/under-pressure or over-temp |

The Python bridge in `../backend/` consumes this stream — schema must stay
in sync with whatever it parses.

## Troubleshooting

| Symptom | Cause / fix |
| :--- | :--- |
| `fork/exec …: permission denied` during compile or upload | Re-run the `find … -exec chmod +x` from setup. |
| `Error starting discovery: …serial-discovery: permission denied` | Same as above — discovery binaries need `+x`. |
| `No boards found` from `arduino-cli board list` | Discovery is broken (chmod), or the udev rule didn't fire (`ls -l /dev/ttyACM0` should show group `dialout`, not `nogroup`). Re-plug. |
| `avrdude: ser_open(): can't open device "/dev/ttyACM0": Permission denied` | You're not in `dialout`, or the udev rule isn't applied. `id` should list `dialout`. |
| `LiquidCrystal.h: No such file or directory` | `arduino-cli lib install LiquidCrystal`. The IDE-bundled copy in `~/.arduino15/libraries/` is **not** on arduino-cli's search path. |
| Compile OK, upload hangs then `not in sync: resp=0x00` | Wrong port, or the board is held in reset by another process (close any open `cat /dev/ttyACM0`). |
| Telemetry shows `temp_c:0.0, hum:0.0` | DHT11 not wired, or wired wrong. Sketch caches `NaN` and prints `0.0`. |
| `press` floats randomly between 0 and 1023 | Pot not wired (A0 floating). Wire per `CIRCUIT.md`. |
| Fan doesn't spin even at high `fan` value | `FAN_MIN_PWM` too low for your motor, transistor base resistor wrong, or flyback diode reversed. |
