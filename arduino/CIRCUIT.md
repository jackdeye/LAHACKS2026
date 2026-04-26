# Aegis Edge — Ventilator Circuit (ELEGOO UNO R3 Super Starter Kit)

A physical UNO-based "ventilator" that streams Temperature / Pressure / Fan
telemetry over USB. A Flipper Zero, wired to the pressure line, plays the
attacker. See `../CLAUDE.MD` for the system-level pitch and `README.md` for
build/flash instructions.

## Contents

1. [System overview](#system-overview)
2. [Bill of materials](#bill-of-materials)
3. [Pin map](#pin-map)
4. [Build order](#build-order)
5. [Wiring details](#wiring-details)
6. [Power budget](#power-budget)
7. [Attack modes](#attack-modes)

---

## System overview

```
       ┌─────────────────────────────────────────────────────┐
       │                  Arduino UNO R3                      │
       │                                                      │
   IR RX ──D3──▶│  receives Flipper attack heartbeat           │
   POT ────A0──▶│  reads "airway pressure" (analog 0–1023)     │
   ◀──────D9──  │  drives transistor → DC motor + fan          │
   ◀──D4-D12──  │  drives 16-pin LCD1602                       │
   ◀──────D8──  │  buzzer (alarm)                              │
   ◀─────D13──  │  status LED                                  │
       │        │                                              │
       │        └──── USB serial @ 115200 ─→ host Python bridge │
       └─────────────────────────────────────────────────────┘
                              ▲
                              │ 38 kHz NEC IR (line of sight)
                              │
                       ┌──────┴───────┐
                       │ Flipper Zero │   (no wires — built-in IR LED)
                       │ aegis_attacker│
                       └──────────────┘
```

The vent rig stands alone. Flipper is an untethered attacker that fakes a
broken sensor over IR — no shared ground, no RF, just line of sight.

---

## Bill of materials

### Vent rig (everything from the ELEGOO Super Starter Kit)

| Qty | Part | Role |
| :-- | :--- | :--- |
| 1 | ELEGOO UNO R3 | Microcontroller |
| 1 | Breadboard (830-tie) | Wiring substrate |
| 1 | DHT11 module | (legacy — sensor is dead, temp/humidity are firmware-synthesised; can be omitted) |
| 1 | 10 kΩ rotary potentiometer | "Airway pressure" analog input |
| 1 | DC motor (mini hobby) + fan blade | Blower |
| 1 | NPN transistor (S8050 or PN2222A) | Low-side motor switch |
| 1 | 1N4007 diode | Motor flyback protection |
| 1 | LCD1602 (parallel, 16-pin) | Patient monitor display |
| 1 | 10 kΩ trim potentiometer | LCD contrast (V0) |
| 1 | Active buzzer | Alarm |
| 1 | LED (any color) | Status indicator |
| 2 | 220 Ω resistor | Transistor base + LED current-limit |
| 1 | HX1838 IR receiver module (38 kHz demod, 3-pin) | Picks up Flipper attack heartbeat |
| — | M-M and M-F jumper wires | Wiring |

### Attack rig

| Qty | Part | Role |
| :-- | :--- | :--- |
| 1 | Flipper Zero running `aegis_attacker.fap` | Attacker (uses built-in IR LED) |

---

## Pin map

### Arduino UNO

| Pin | Connects to | Notes |
| :-- | :---------- | :---- |
| 5V          | Breadboard + rail | Powers all modules (incl. IR receiver) |
| GND         | Breadboard − rail | Common ground for all on-board modules |
| D3          | IR receiver DATA (HX1838 OUT) | Flipper attack heartbeat |
| D4          | LCD RS | |
| D5          | LCD E (Enable) | |
| D6          | LCD D4 | 4-bit mode |
| D8          | Buzzer (+) | |
| D9 (PWM)    | Transistor base via 220 Ω | Fan speed (Timer1 — clear of IRremote's Timer2) |
| D10         | LCD D5 | |
| D11         | LCD D6 | |
| D12         | LCD D7 | |
| D13         | Status LED via 220 Ω | On-board LED also blinks |
| A0          | Pot wiper | Pressure |
| D2, D7, A1–A5 | unused | A4/A5 reserved if you ever swap to I²C LCD |

### Flipper Zero

No header wiring. The attacker uses the Flipper's built-in 38 kHz IR LED
on the top edge — aim it at the IR receiver from up to ~5 m away.

---

## Build order

Do these in sequence. After each step, power-cycle and check that the
firmware's serial output looks sane before moving on.

1. **Rails.** Run 5 V and GND from the UNO to the breadboard's `+` and `−`
   rails. Bridge both rails across the gap if your breadboard has a split.
2. **DHT11** — confirm `temp_c` and `hum` start populating in the JSON.
3. **Pressure pot** — wiper to A0; `press` should sweep 0–1023 as you turn it.
4. **Fan** (motor + transistor + flyback diode). Start with the pot near
   middle so the fan spins immediately on power-on.
5. **LCD1602** — wire VSS/VDD/RS/E/D4–D7 plus the contrast trim-pot. Sweep
   the trim until characters appear.
6. **Buzzer + status LED.**
7. **IR receiver** — wire the HX1838 module's VCC/GND/OUT to 5V/GND/D3.
   Launch `aegis_attacker` on the Flipper, leave it in `IDLE`, confirm the
   vent still runs normally and the alarm only fires when you toggle the
   Flipper into `ATTACKING` while aimed at the receiver.

---

## Wiring details

### IR receiver (HX1838 / equivalent 38 kHz demodulator)

```
Module pin   Wire to
VCC          5V rail
GND          GND rail
OUT (DATA)   D3
```

Most kit modules already include the bias resistor and decoupling cap on
the PCB — no extras needed. Aim the Flipper's top edge at the dome.

### Pressure potentiometer

```
Pin 1 (outer) → 5V rail
Pin 2 (wiper) → A0
Pin 3 (outer) → GND rail
```

### DC motor + fan, low-side NPN switch

```
              5V rail ─────┬──────────┐
                           │          │
                          ─┴─        Motor
                  1N4007  ▲         (+)/(-)
                   diode  │          │
                           └─────────┤
                                     │  ← Collector
                                   │ │
                                   │/   NPN (S8050 / PN2222A)
                          D9 ──220Ω─┤   Base
                                   │\
                                   │ │  ← Emitter
                                     │
                                    GND rail
```

- Diode **band (cathode) faces 5 V**. Backwards = dead transistor on first
  switch-off.
- If the motor doesn't spin reliably, raise `FAN_MIN_PWM` in the firmware.

### LCD1602 — parallel 4-bit mode

```
LCD pin  Name  Wire to
1        VSS   GND rail
2        VDD   5V rail
3        V0    Trim-pot wiper (trim-pot ends to 5V and GND)
4        RS    D4
5        RW    GND rail            ← tie low; we only ever write
6        E     D5
7-10     D0-D3 (no connect — 4-bit mode)
11       D4    D6
12       D5    D10
13       D6    D11
14       D7    D12
15       A     5V rail (add 220 Ω inline if backlight is too bright)
16       K     GND rail
```

Adjust the trim pot until characters show. Full CW or CCW typically gives
blank or solid blocks — sweep slowly through the middle.

### Buzzer + status LED

```
Buzzer (+) → D8         LED anode  → 220 Ω → D13
Buzzer (−) → GND rail   LED cathode → GND rail
```

### Flipper Zero IR injection

No wires. The Flipper's built-in IR LED (top edge) emits a 38 kHz NEC
heartbeat — `addr=0x00, cmd=0x42` — every ~150 ms while the app is in
`ATTACKING`. The HX1838 demodulates it to a clean digital pulse train on
D3 and the IRremote library on the UNO decodes the frame.

Range and aim:

- ~5 m line-of-sight in normal indoor lighting; less under direct sun.
- The HX1838 has a fairly wide acceptance cone (~±45°), but the Flipper's
  IR LED is more directional. If frames drop out, point more carefully.
- The Arduino treats "attack on" as `(now - last_packet) < 400 ms`, so a
  single missed frame is harmless; stopping the Flipper's transmission
  releases the alarm within ~400 ms.

---

## Power budget

| Load | Approx draw |
| :--- | ----------: |
| UNO + DHT11 + LCD + LED | ~120 mA |
| Buzzer (alarm only)     | ~30 mA  |
| DC motor (running)      | ~150–250 mA |
| **Worst case**          | **~400 mA** |

USB 2.0 supplies 500 mA, so this fits — but if the host port is on a
non-powered hub, plug the UNO into a powered hub or use the barrel jack
with a 7–12 V wall-wart.

---

## Attack modes

Implemented in `flipper/aegis_attacker/aegis_attacker.c`. Toggle with
the Flipper's OK button.

| Mode | IR carrier | Demo behavior |
| :--- | :--------- | :------------ |
| **IDLE** | silent | Normal vent operation. |
| **ATTACKING** | 38 kHz NEC frame `addr=0x00 cmd=0x42` retransmitted every ~150 ms | Arduino marks the temperature sensor as failed (publishes `temp_c=NaN`); vent firmware cuts the fan and raises the alarm. |

The bridge detects the failed-sensor state by watching the temperature
field, then the LLM patches by switching to a synthesised value derived
from pressure and fan PWM.

> **Why IR instead of GPIO?** The first cut of the demo wired Flipper
> PA7 → 1 kΩ → A0 to spoof the pressure ADC directly. That works but
> requires a shared ground and a hard-wired attacker, which sells the
> wrong story (an attacker with physical access to the wiring already
> wins). IR makes the attack untethered and visually obvious — the
> Flipper sits on the table, the target alarms when you point at it.
> The downside is that the attack now disables the temperature channel
> rather than the pressure channel; both produce the same headline
> (vent thinks the patient circuit is broken), and the bridge's recovery
> story is unchanged.
