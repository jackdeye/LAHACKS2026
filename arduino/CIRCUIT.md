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
   DHT11 ──D2──▶│  reads temp/humidity                         │
   POT ────A0──▶│  reads "airway pressure" (analog 0–1023)     │
   ◀──────D9──  │  drives transistor → DC motor + fan          │
   ◀──D4-D12──  │  drives 16-pin LCD1602                       │
   ◀──────D8──  │  buzzer (alarm)                              │
   ◀─────D13──  │  status LED                                  │
       │        │                                              │
       │        └──── USB serial @ 115200 ─→ host Python bridge │
       └─────────────────────────────────────────────────────┘
                              ▲
                              │ injects 3.3 V on A0 via 1 kΩ
                              │
                       ┌──────┴───────┐
                       │ Flipper Zero │   (PA7 → 1 kΩ → A0, GND ↔ GND)
                       │ aegis_attacker│
                       └──────────────┘
```

The vent rig stands alone. Flipper is a bolt-on attacker that overrides the
pressure reading without RF.

---

## Bill of materials

### Vent rig (everything from the ELEGOO Super Starter Kit)

| Qty | Part | Role |
| :-- | :--- | :--- |
| 1 | ELEGOO UNO R3 | Microcontroller |
| 1 | Breadboard (830-tie) | Wiring substrate |
| 1 | DHT11 module | Inspired-gas temp + humidity |
| 1 | 10 kΩ rotary potentiometer | "Airway pressure" analog input |
| 1 | DC motor (mini hobby) + fan blade | Blower |
| 1 | NPN transistor (S8050 or PN2222A) | Low-side motor switch |
| 1 | 1N4007 diode | Motor flyback protection |
| 1 | LCD1602 (parallel, 16-pin) | Patient monitor display |
| 1 | 10 kΩ trim potentiometer | LCD contrast (V0) |
| 1 | Active buzzer | Alarm |
| 1 | LED (any color) | Status indicator |
| 2 | 220 Ω resistor | Transistor base + LED current-limit |
| — | M-M and M-F jumper wires | Wiring |

### Attack rig

| Qty | Part | Role |
| :-- | :--- | :--- |
| 1 | Flipper Zero running `aegis_attacker.fap` | Attacker |
| 1 | 1 kΩ resistor | A0 injection — current limit |
| 2 | M-F jumpers | Flipper header → breadboard |

---

## Pin map

### Arduino UNO

| Pin | Connects to | Notes |
| :-- | :---------- | :---- |
| 5V          | Breadboard + rail | Powers all modules |
| GND         | Breadboard − rail | **Common ground — Flipper GND ties here too** |
| D2          | DHT11 DATA | |
| D4          | LCD RS | |
| D5          | LCD E (Enable) | |
| D6          | LCD D4 | 4-bit mode |
| D8          | Buzzer (+) | |
| D9 (PWM)    | Transistor base via 220 Ω | Fan speed |
| D10         | LCD D5 | |
| D11         | LCD D6 | |
| D12         | LCD D7 | |
| D13         | Status LED via 220 Ω | On-board LED also blinks |
| A0          | Pot wiper **and** Flipper PA7 via 1 kΩ | Pressure / spoof injection |
| D3, D7, A1–A5 | unused | A4/A5 reserved if you ever swap to I²C LCD |

### Flipper Zero (top header)

| Pin # | Name | Connects to | Notes |
| :---- | :--- | :---------- | :---- |
| 2  | PA7 | Arduino A0 via 1 kΩ | Injection output |
| 11 | GND | Arduino GND rail | Mandatory — without this the attack does nothing |

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
7. **Flipper injection** — solder/jumper PA7 → 1 kΩ → A0, and GND ↔ GND.
   Launch `aegis_attacker` on the Flipper, leave it in `Standby`, confirm
   the pot still controls A0 normally.

---

## Wiring details

### DHT11 (3-pin module — pull-up is built in)

```
DHT11 VCC  → 5V rail
DHT11 GND  → GND rail
DHT11 DATA → D2
```

### Pressure potentiometer

```
Pin 1 (outer) → 5V rail
Pin 2 (wiper) → A0
Pin 3 (outer) → GND rail
```

This is the line the Flipper attacks. The Flipper's 1 kΩ injection wire
also lands on A0 (see [Attack modes](#attack-modes)).

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

### Flipper Zero injection

```
Flipper pin 11  (GND) ──────────────────── breadboard GND rail
Flipper pin 2   (PA7) ────[ 1 kΩ ]──────── A0  (same node as the pot wiper)
```

Why 1 kΩ:

- Flipper PA7 push-pull (~50 Ω out) easily dominates the pot's ~5 kΩ wiper
  impedance, so the spoofed value sticks.
- The resistor caps any back-current to ~5 mA if A0 is ever wrongly driven
  as an output, protecting the STM32's 3.3 V GPIO from 5 V back-feed.

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

Implemented in `flipper/aegis_attacker/aegis_attacker.c`. Cycle modes with
the Flipper's OK button, adjust pulse rate with Up/Down.

| Mode | PA7 state | A0 voltage | ADC reading | Demo behavior |
| :--- | :-------- | :--------- | :---------- | :------------ |
| **Standby** | Analog / high-Z | pot wiper, 0–5 V | 0–1023 | Normal vent operation. |
| **Spoof / HIGH** | Push-pull HIGH (3.3 V) | ~3.0 V | ~640 | Pressure pinned in the firmware's safe band (150–850) — alarm never fires regardless of real conditions. The headline attack. |
| **Noise / Pulse** | Square wave, 40 µs – 10 ms | aliases against the AVR ADC sample clock | jitters wildly | Sensor "twitches" — looks like flow chatter, harder for the bridge to debug. |

The bridge detects the spoof by watching pressure's first-difference go to
zero while temperature and fan PWM are still moving — a multivariate
inconsistency the LLM patches with a virtual-pressure function.

> **Sub-GHz EMI alternative (not recommended for the live demo).** An
> earlier draft of this doc proposed a CC1101 EMI attack. It is
> theoretically valid but unreliable on stage: 10 mW into a 5 kΩ source
> requires a tuned λ/4 antenna inches from the wire to shift the ADC by
> useful counts. The GPIO injection above is deterministic and tells the
> exact same threat story ("a tampered sensor is lying").
