// Aegis Edge — Ventilator firmware
// Streams JSON telemetry over Serial @ 115200 for the Python bridge.
// Schema: {"t":<ms>,"temp_c":<f>,"hum":<f>,"press":<int 0-1023>,"fan":<0-255>,"alarm":<0|1>}
//
// The DHT11 module on this rig has died, so temp/humidity are synthesized in
// firmware. To keep the demo honest, D2 (the old DHT data line) is repurposed
// as a tap on the Flipper PA7 attack line: while PA7 is high we publish NaN
// for temp_c, mirroring the dropout a real broken sensor would emit under
// fault injection. Wire Flipper PA7 → D2, with a 10 kΩ pull-down on D2 so it
// reads LOW while the Flipper is in IDLE / high-Z.

#include <LiquidCrystal.h>

// --- Pin map (matches CIRCUIT.md, with D2 repurposed) ---
#define PIN_FLIPPER_DETECT 2
#define PIN_BUZZER         8
#define PIN_FAN_PWM        9
#define PIN_LED            13
#define PIN_PRESSURE       A0

// LCD1602 parallel, 4-bit mode: RS, E, D4, D5, D6, D7
LiquidCrystal lcd(4, 5, 6, 10, 11, 12);

// Pressure thresholds (raw 10-bit ADC). Map to cmH2O downstream if desired.
#define PRESS_LOW    150     // disconnect / leak
#define PRESS_HIGH   850     // over-pressure
#define TEMP_HIGH_C  40.0

// Fan duty mapping: pressure setpoint drives blower. Below FAN_MIN_PWM the
// motor stalls (back-EMF > drive); raise this if your motor doesn't spin.
#define FAN_MIN_PWM  90
#define FAN_MAX_PWM  255

// Synthetic inspired-gas envelope — plausible room conditions with mild drift.
#define FAKE_TEMP_BASE_C   22.5
#define FAKE_TEMP_MIN_C    20.0
#define FAKE_TEMP_MAX_C    26.0
#define FAKE_HUM_BASE_PCT  45.0
#define FAKE_HUM_MIN_PCT   40.0
#define FAKE_HUM_MAX_PCT   55.0

unsigned long lastTelemetry = 0;
unsigned long lastDisplay   = 0;
const unsigned long TELEMETRY_MS = 100;   // 10 Hz to the bridge
const unsigned long DISPLAY_MS   = 500;   // 2 Hz to the LCD (matches old DHT cadence)

float   tempC       = FAKE_TEMP_BASE_C;
float   hum         = FAKE_HUM_BASE_PCT;
int     pressureRaw = 0;
uint8_t fanPwm      = 0;
bool    alarm       = false;
bool    flipperHigh = false;

void setup() {
  Serial.begin(115200);

  pinMode(PIN_LED, OUTPUT);
  pinMode(PIN_BUZZER, OUTPUT);
  pinMode(PIN_FAN_PWM, OUTPUT);
  pinMode(PIN_FLIPPER_DETECT, INPUT);

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
  flipperHigh = (digitalRead(PIN_FLIPPER_DETECT) == HIGH);

  if (now - lastDisplay >= DISPLAY_MS) {
    lastDisplay = now;
    updateFakeEnv();
    updateDisplay();
  }

  uint16_t duty = map(pressureRaw, 0, 1023, FAN_MIN_PWM, FAN_MAX_PWM);
  fanPwm = (uint8_t)constrain(duty, 0, 255);
  analogWrite(PIN_FAN_PWM, fanPwm);

  // Real-temp branch is NaN-guarded — under attack reportedTemp() goes NaN
  // and drops out of the alarm condition, same as a dead sensor would.
  float reported = reportedTemp();
  alarm = (pressureRaw < PRESS_LOW) ||
          (pressureRaw > PRESS_HIGH) ||
          (!isnan(reported) && reported > TEMP_HIGH_C);

  digitalWrite(PIN_LED, alarm ? HIGH : LOW);
  digitalWrite(PIN_BUZZER, alarm ? HIGH : LOW);

  if (now - lastTelemetry >= TELEMETRY_MS) {
    lastTelemetry = now;
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

void emitTelemetry(unsigned long t) {
  float reported = reportedTemp();
  Serial.print(F("{\"t\":"));      Serial.print(t);
  Serial.print(F(",\"temp_c\":")); Serial.print(isnan(reported) ? 0.0 : reported, 1);
  Serial.print(F(",\"hum\":"));    Serial.print(isnan(hum)      ? 0.0 : hum,      1);
  Serial.print(F(",\"press\":"));  Serial.print(pressureRaw);
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

  lcd.setCursor(0, 1);
  lcd.print("P:");
  if (pressureRaw < 1000) lcd.print(' ');
  if (pressureRaw < 100)  lcd.print(' ');
  if (pressureRaw < 10)   lcd.print(' ');
  lcd.print(pressureRaw);
  lcd.print(" F:");
  if (fanPwm < 100) lcd.print(' ');
  if (fanPwm < 10)  lcd.print(' ');
  lcd.print(fanPwm);
  lcd.print(alarm ? " !" : "  ");
}
