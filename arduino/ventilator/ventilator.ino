// Aegis Edge — Ventilator firmware
// Streams JSON telemetry over Serial @ 115200 for the Python bridge.
// Schema: {"t":<ms>,"temp_c":<f>,"hum":<f>,"press":<int 0-1023>,"light":<int 0-1023>,"fan":<0-255>,"alarm":<0|1>}
//
// The DHT11 module on this rig has died, so temp/humidity are synthesized in
// firmware. The Flipper attacker beams a 38 kHz NEC IR heartbeat at the
// receiver on D3; while we keep seeing it we publish NaN for temp_c, mirroring
// the dropout a real broken sensor would emit under fault injection. No wires
// to the Flipper — line-of-sight only.

#include <LiquidCrystal.h>

#define DECODE_NEC
#include <IRremote.hpp>

// --- Pin map (matches CIRCUIT.md) ---
#define PIN_IR_RECEIVE     3
#define PIN_BUZZER         8
#define PIN_FAN_PWM        9
#define PIN_LED            13
#define PIN_PRESSURE       A0
#define PIN_LIGHT          A2

// LCD1602 parallel, 4-bit mode: RS, E, D4, D5, D6, D7
LiquidCrystal lcd(4, 5, 6, 10, 11, 12);

// Fan duty mapping: pressure setpoint drives blower. Below FAN_MIN_PWM the
// motor stalls (back-EMF > drive); raise this if your motor doesn't spin.
#define FAN_MIN_PWM  90
#define FAN_MAX_PWM  255

// Light sensor smoothing — 8-tap moving average over the photoresistor ADC.
// At ~10 Hz sampling cadence this is an ~800 ms window, enough to smooth
// 60 Hz fluorescent flicker without making the value feel sluggish.
#define LIGHT_AVG_SAMPLES  8

// Synthetic inspired-gas envelope — plausible room conditions with mild drift.
#define FAKE_TEMP_BASE_C   22.5
#define FAKE_TEMP_MIN_C    20.0
#define FAKE_TEMP_MAX_C    26.0
#define FAKE_HUM_BASE_PCT  45.0
#define FAKE_HUM_MIN_PCT   40.0
#define FAKE_HUM_MAX_PCT   55.0

// Detection policy: only the Flipper's specific NEC payload counts. The
// fan's brushed motor radiates broadband RF that the HX1838 demodulates
// into garbage "frames" — most fail addr/cmd, but stray pulse trains can
// decode as bare NEC repeats (no addr/cmd carried) or as one-off matches.
// We defend in two layers: (1) trust a repeat only if it chains to a
// recent verified addr/cmd hit, and (2) require MIN_BURST_HITS confirmed
// hits inside BURST_WINDOW_MS before we latch the attack window. Once
// latched, the window is held open for ATTACK_TIMEOUT_MS so slow Flipper
// retransmits and brief LOS dropouts don't release it.
#define ATTACK_TIMEOUT_MS    2000UL
#define ATTACK_ADDR          0x00
#define ATTACK_CMD           0x42
#define REPEAT_GRACE_MS      250UL    // NEC repeats arrive ~110ms after parent
#define BURST_WINDOW_MS      500UL
#define MIN_BURST_HITS       2

unsigned long lastTelemetry    = 0;
unsigned long lastDisplay      = 0;
unsigned long lastAttackPacket = 0;
unsigned long lastVerifiedHit  = 0;
unsigned long lastHitTime      = 0;
uint8_t       hitsInBurst      = 0;
const unsigned long TELEMETRY_MS = 100;   // 10 Hz to the bridge
const unsigned long DISPLAY_MS   = 500;   // 2 Hz to the LCD (matches old DHT cadence)

float   tempC       = FAKE_TEMP_BASE_C;
float   hum         = FAKE_HUM_BASE_PCT;
int     pressureRaw = 0;
uint8_t fanPwm      = 0;
bool    alarm       = false;
bool    flipperHigh = false;

int      lightSamples[LIGHT_AVG_SAMPLES] = {0};
uint8_t  lightSampleIdx                  = 0;
long     lightSampleSum                  = 0;
int      lightAvg                        = 0;

void setup() {
  Serial.begin(115200);

  pinMode(PIN_LED, OUTPUT);
  pinMode(PIN_BUZZER, OUTPUT);
  pinMode(PIN_FAN_PWM, OUTPUT);

  // Status LED is on D13, the IRremote built-in feedback pin — leave feedback
  // off or every IR frame would also blink the alarm light.
  IrReceiver.begin(PIN_IR_RECEIVE, DISABLE_LED_FEEDBACK);

  // Seed off a floating ADC so the synthetic walk doesn't repeat each boot.
  randomSeed(analogRead(A1));

  lcd.begin(16, 2);
  lcd.clear();
  lcd.setCursor(0, 0); lcd.print("Aegis Vent v1");
  lcd.setCursor(0, 1); lcd.print("Booting...");
  delay(1500);
  lcd.clear();
}

void loop() {
  unsigned long now = millis();

  pressureRaw = analogRead(PIN_PRESSURE);

  if (IrReceiver.decode()) {
    bool isMatch = (IrReceiver.decodedIRData.protocol == NEC) &&
                   (IrReceiver.decodedIRData.address == ATTACK_ADDR) &&
                   (IrReceiver.decodedIRData.command == ATTACK_CMD);
    bool isRepeat = (IrReceiver.decodedIRData.protocol == NEC) &&
                    (IrReceiver.decodedIRData.flags & IRDATA_FLAGS_IS_REPEAT);
    // A repeat carries no addr/cmd, so it's only credible when it follows a
    // recent verified match. A standalone repeat is almost certainly fan EMF.
    bool isChainedRepeat = isRepeat && lastVerifiedHit != 0 &&
                           (now - lastVerifiedHit) < REPEAT_GRACE_MS;
    bool isHit = isMatch || isChainedRepeat;
    if (isMatch) lastVerifiedHit = now;
    if (isHit) {
      if (lastHitTime == 0 || (now - lastHitTime) > BURST_WINDOW_MS) {
        hitsInBurst = 1;
      } else if (hitsInBurst < 255) {
        hitsInBurst++;
      }
      lastHitTime = now;
      if (hitsInBurst >= MIN_BURST_HITS) lastAttackPacket = now;
    }
    IrReceiver.resume();
  }
  flipperHigh = (lastAttackPacket != 0) &&
                ((now - lastAttackPacket) < ATTACK_TIMEOUT_MS);

  if (now - lastDisplay >= DISPLAY_MS) {
    lastDisplay = now;
    updateFakeEnv();
    updateDisplay();
  }

  // Sensor-died is the sole trigger: cut the fan and light the LED. Anything
  // else (pressure excursions, over-temp) leaves the rig running normally.
  alarm = isnan(reportedTemp());

  if (alarm) {
    fanPwm = 0;
    // analogWrite(0) leaves the Timer1 output attached to the pin, which
    // can leak enough drive to keep the brushed motor coasting. digitalWrite
    // detaches the timer and forces the line LOW for a hard cut.
    digitalWrite(PIN_FAN_PWM, LOW);
  } else {
    uint16_t duty = map(pressureRaw, 0, 1023, FAN_MIN_PWM, FAN_MAX_PWM);
    fanPwm = (uint8_t)constrain(duty, 0, 255);
    analogWrite(PIN_FAN_PWM, fanPwm);
  }

  digitalWrite(PIN_LED, alarm ? HIGH : LOW);
  digitalWrite(PIN_BUZZER, alarm ? HIGH : LOW);

  if (now - lastTelemetry >= TELEMETRY_MS) {
    lastTelemetry = now;
    sampleLight();
    emitTelemetry(now);
  }
}

// Random-walk the synthetic env within plausible bands so the bridge sees
// realistic small-scale drift rather than a frozen value.
void updateFakeEnv() {
  tempC += random(-10, 11) * 0.02f;
  if (tempC < FAKE_TEMP_MIN_C) tempC = FAKE_TEMP_MIN_C;
  if (tempC > FAKE_TEMP_MAX_C) tempC = FAKE_TEMP_MAX_C;

  hum += random(-10, 11) * 0.05f;
  if (hum < FAKE_HUM_MIN_PCT) hum = FAKE_HUM_MIN_PCT;
  if (hum > FAKE_HUM_MAX_PCT) hum = FAKE_HUM_MAX_PCT;
}

float reportedTemp() {
  return flipperHigh ? NAN : tempC;
}

void sampleLight() {
  int raw = analogRead(PIN_LIGHT);
  lightSampleSum -= lightSamples[lightSampleIdx];
  lightSamples[lightSampleIdx] = raw;
  lightSampleSum += raw;
  lightSampleIdx = (lightSampleIdx + 1) % LIGHT_AVG_SAMPLES;
  lightAvg = (int)(lightSampleSum / LIGHT_AVG_SAMPLES);
}

void emitTelemetry(unsigned long t) {
  float reported = reportedTemp();
  Serial.print(F("{\"t\":"));      Serial.print(t);
  Serial.print(F(",\"temp_c\":")); Serial.print(isnan(reported) ? 0.0 : reported, 1);
  Serial.print(F(",\"hum\":"));    Serial.print(isnan(hum)      ? 0.0 : hum,      1);
  Serial.print(F(",\"press\":"));  Serial.print(pressureRaw);
  Serial.print(F(",\"light\":"));  Serial.print(lightAvg);
  Serial.print(F(",\"fan\":"));    Serial.print(fanPwm);
  Serial.print(F(",\"alarm\":"));  Serial.print(alarm ? 1 : 0);
  Serial.println(F("}"));
}

void updateDisplay() {
  float reported = reportedTemp();

  lcd.setCursor(0, 0);
  lcd.print("T:");
  if (isnan(reported)) lcd.print("--.-");
  else { if (reported < 10) lcd.print(' '); lcd.print(reported, 1); }
  lcd.print((char)223); lcd.print("C ");

  lcd.print("H:");
  if (isnan(hum)) lcd.print("--");
  else { if (hum < 10) lcd.print(' '); lcd.print((int)hum); }
  lcd.print('%');

  // Variable-width pressure means the row can shrink between frames; clear
  // first so old characters don't ghost when we draw fewer than before.
  lcd.setCursor(0, 1);
  lcd.print(F("                "));
  lcd.setCursor(0, 1);
  lcd.print("P:");
  lcd.print(pressureRaw);
  lcd.print(" F:");
  if (fanPwm < 100) lcd.print(' ');
  if (fanPwm < 10)  lcd.print(' ');
  lcd.print(fanPwm);
  lcd.print(" L:");
  // Scale 0-1023 to 0-99 so light fits a 2-char field.
  int lightDisp = (int)((long)lightAvg * 99L / 1023L);
  if (lightDisp < 10) lcd.print(' ');
  lcd.print(lightDisp);
}
