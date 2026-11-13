// Smart Water Dispenser: firmware ESP32 (Perception Layer)
//
// Tugas ESP32 (Laporan Arsitektur Bab 1.3/8.1): baca berat, tare + simpan offset di NVS,
// publish "raw" tiap 10 dtk, dan MENJALANKAN keputusan Worker (LCD/LED/buzzer).
// Volume, persentase, dan status air dihitung Node.js Worker, bukan di sini.
//
// Pustaka (Library Manager): HX711 (bogde), LiquidCrystal I2C (Frank de Brabander),
//                            PubSubClient (Nick O'Leary), ArduinoJson v7 (Benoit Blanchon).
//
// BELUM DIKOMPILASI/DIUJI pada perangkat atau Wokwi: uji dulu di Wokwi (lihat README).

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <HX711.h>
#include <Preferences.h>

// ======================= KONFIGURASI =======================
#define WOKWI 0    // 0 = perangkat fisik, 1 = simulator Wokwi
#define USE_TLS 0  // 0 = Broker lokal laptop (port 1883), 1 = EMQX Cloud (port 8883 TLS)

#if WOKWI
  // Pin sesuai rangkaian Wokwi di Laporan Wokwi (Tabel 3.2).
  const int HX711_DT = 32, HX711_SCK = 33, LED_PIN = 18, BUZZER_PIN = 25;
  const float CAL_FACTOR = 420.0f;  // komponen wokwi-hx711 50kg: 420 unit/kg
  const char* WIFI_SSID = "Wokwi-GUEST";
  const char* WIFI_PASS = "";
#else
  // Pin Laporan Arsitektur Bab 3.2 (hindari GPIO12 yang merupakan strapping pin).
  const int HX711_DT = 32, HX711_SCK = 33, LED_PIN = 18, BUZZER_PIN = 25;
  const float CAL_FACTOR = 1.0f;  // WAJIB dikalibrasi dengan massa referensi (Lampiran 1 laporan)
  const char* WIFI_SSID = "Lab IoT";
  const char* WIFI_PASS = "iflabiot";
#endif
const int LCD_SDA = 21, LCD_SCL = 22;

// Jika USE_TLS = 0 (Broker Lokal):
//  - MQTT_HOST diisi IP laptopmu (contoh: "192.168.1.15")
//  - MQTT_PORT = 1883
//  - MQTT_USER & MQTT_PASS cukup dikosongkan ("")
//
// Jika USE_TLS = 1 (EMQX Cloud):
//  - MQTT_HOST = "xxxx.emqxsl.com", MQTT_PORT = 8883
//  - MQTT_USER & MQTT_PASS diisi user yang dibuat di EMQX
const char* MQTT_HOST = "192.168.56.1";  // GANTI dengan IP laptopmu (cek via ipconfig)
const int   MQTT_PORT = 1883;
const char* MQTT_USER = "";
const char* MQTT_PASS = "";

const char* DEVICE_ID    = "dispenser-001";
const char* TOPIC_RAW    = "dispenser/001/raw";
const char* TOPIC_STATUS = "dispenser/001/status";
const char* TOPIC_AVAIL  = "dispenser/001/availability";

const unsigned long READ_MS = 1000, PUBLISH_MS = 2000, SERVER_TIMEOUT_MS = 30000;
const float STABLE_KG = 0.05f;  // selisih maks. pembacaan saat tare dianggap stabil
// ===========================================================

#if USE_TLS
  WiFiClientSecure net;
#else
  WiFiClient net;
#endif
PubSubClient mqtt(net);
HX711 scale;
LiquidCrystal_I2C lcd(0x27, 16, 2);
Preferences prefs;

char bootId[5];
uint32_t seqNo = 0;

// Tare (state: READY | TARE_REQUIRED | FAILED)
String tareState = "TARE_REQUIRED", tareId = "", lastAck = "", tareError = "", lastCmd = "", pendingTare = "";

// Sensor: median 5 sampel (1 sampel/dtk)
float samples[5];
int sampleCount = 0, sampleIdx = 0;
bool sensorOk = false;

// Instruksi terakhir dari Worker
unsigned long lastInstruction = 0, lastStatusMs = 0;
String devState = "", waterStatus = "", ledMode = "OFF";
float volumeL = 0, pctF = -1;
int beepsCfg = 0, repeatSec = 0;
String alarmStatus = "";  // status air yang sudah dibunyikan

// Buzzer non-blocking
int beepsLeft = 0;
bool buzzOn = false;
unsigned long buzzNextMs = 0, nextRepeatMs = 0;

unsigned long lastReadMs = 0, lastPublishMs = 0, lastWifiTry = 0, lastMqttTry = 0, lastLcdMs = 0;
String lcdLine0 = "", lcdLine1 = "";

// ---------- util ----------
void buzzerSet(bool on) {
#ifdef WOKWI
  if (on) tone(BUZZER_PIN, 2000); else noTone(BUZZER_PIN);  // wokwi-buzzer bersifat pasif
#else
  digitalWrite(BUZZER_PIN, on ? HIGH : LOW);  // buzzer aktif low-current (Lampiran 4)
#endif
}

void lcdShow(const String& a, const String& b) {
  if (a == lcdLine0 && b == lcdLine1) return;
  lcdLine0 = a; lcdLine1 = b;
  String pa = a, pb = b;
  while (pa.length() < 16) pa += ' ';
  while (pb.length() < 16) pb += ' ';
  lcd.setCursor(0, 0); lcd.print(pa.substring(0, 16));
  lcd.setCursor(0, 1); lcd.print(pb.substring(0, 16));
}

float median(float* v, int n) {
  float t[5];
  for (int i = 0; i < n; i++) t[i] = v[i];
  for (int i = 1; i < n; i++) { float k = t[i]; int j = i - 1; while (j >= 0 && t[j] > k) { t[j + 1] = t[j]; j--; } t[j + 1] = k; }
  return t[n / 2];
}

bool serverOffline() { return millis() - lastStatusMs > SERVER_TIMEOUT_MS; }

// ---------- sensor ----------
void pushSample(float w) { samples[sampleIdx] = w; sampleIdx = (sampleIdx + 1) % 5; if (sampleCount < 5) sampleCount++; }

void readSensor() {
  if (!scale.wait_ready_timeout(200)) { sensorOk = false; sampleCount = 0; return; }
  float w = scale.get_units(1);
  if (isnan(w) || isinf(w)) { sensorOk = false; sampleCount = 0; return; }
  sensorOk = true;
  pushSample(w);
}

void refillFilter() {  // setelah tare, buang sampel lama agar raw berikutnya tidak memuat berat sebelum tare
  sampleCount = 0; sampleIdx = 0;
  for (int i = 0; i < 5; i++) { readSensor(); delay(100); }
}

// ---------- tare ----------
void doTare(const String& id) {
  lcdShow("PROSES TARE...", "Mohon tunggu");
  String err = "";
  if (!scale.wait_ready_timeout(1000)) {
    err = "HX711 tidak siap";
  } else {
    float mn = 1e9f, mx = -1e9f;  // pemeriksaan keterbacaan/stabilitas (Bab 4.7 langkah 4)
    for (int i = 0; i < 10; i++) { float w = scale.get_units(1); mn = min(mn, w); mx = max(mx, w); delay(100); }
    if (mx - mn > STABLE_KG) err = "Berat tidak stabil";
  }
  lastCmd = id;  // idempoten: command.id ini tidak akan dijalankan lagi, berhasil maupun gagal
  prefs.putString("lastCmd", id);
  if (err.length() == 0) {
    scale.tare(15);
    prefs.putLong("offset", scale.get_offset());
    prefs.putBool("hasOffset", true);
    prefs.putString("tareId", id);
    tareState = "READY"; tareId = id; lastAck = id; tareError = "";
    Serial.printf("[TARE] sukses id=%s offset=%ld\n", id.c_str(), scale.get_offset());
  } else {
    tareState = "FAILED"; tareId = id; lastAck = ""; tareError = err;
    Serial.printf("[TARE] GAGAL id=%s: %s\n", id.c_str(), err.c_str());
  }
  refillFilter();
  lastPublishMs = 0;  // kirim ACK segera
}

// ---------- MQTT ----------
void publishRaw() {
  if (!mqtt.connected()) return;
  JsonDocument d;
  d["device_id"] = DEVICE_ID;
  d["boot_id"] = bootId;
  d["seq"] = ++seqNo;
  bool ok = sensorOk && sampleCount > 0;
  if (ok) d["water_weight_kg"] = roundf(median(samples, sampleCount) * 100.0f) / 100.0f;
  else d["water_weight_kg"] = nullptr;
  d["sensor_ok"] = ok;
  d["tare_state"] = tareState;
  if (tareId.length()) d["tare_id"] = tareId; else d["tare_id"] = nullptr;
  if (lastAck.length()) d["last_command_ack"] = lastAck; else d["last_command_ack"] = nullptr;
  if (tareState == "FAILED") d["tare_error"] = tareError;
  char buf[320];
  serializeJson(d, buf, sizeof(buf));
  mqtt.publish(TOPIC_RAW, buf, false);
}

void startBeeps(int n) { beepsLeft = n; buzzOn = false; buzzNextMs = millis(); }

void onMessage(char* topic, byte* payload, unsigned int len) {
  JsonDocument d;
  if (deserializeJson(d, payload, len)) return;
  if (strcmp(d["device_id"] | "", DEVICE_ID) != 0) return;
  if (strcmp(d["boot_id"] | "", bootId) != 0) return;  // balasan untuk sesi boot lain
  unsigned long id = d["instruction_id"] | 0UL;
  if (id <= lastInstruction) return;  // duplikat QoS 1 / instruksi lama (Bab 5.3)
  lastInstruction = id;
  lastStatusMs = millis();

  devState = String(d["device_state"] | "");
  waterStatus = String(d["water_status"] | "");
  ledMode = String(d["led_mode"] | "OFF");
  volumeL = d["volume_liter"] | 0.0f;
  pctF = d["percentage"].isNull() ? -1 : (float)(d["percentage"] | 0.0f);
  beepsCfg = d["buzzer_beeps"] | 0;
  repeatSec = d["buzzer_repeat_sec"] | 0;

  JsonObject c = d["command"];
  if (!c.isNull() && strcmp(c["type"] | "", "TARE") == 0) {
    String cid = String(c["id"] | "");
    if (cid.length() && cid != lastCmd && pendingTare.length() == 0) pendingTare = cid;  // dijalankan di loop()
  }
}

bool connectMqtt() {
  String cid = String("esp32-") + DEVICE_ID;
  const char* will = "{\"device_id\":\"dispenser-001\",\"connection\":\"offline\"}";
  if (!mqtt.connect(cid.c_str(), MQTT_USER, MQTT_PASS, TOPIC_AVAIL, 1, true, will)) return false;
  mqtt.publish(TOPIC_AVAIL, "{\"device_id\":\"dispenser-001\",\"connection\":\"online\"}", true);
  mqtt.subscribe(TOPIC_STATUS, 1);
  return true;
}

// ---------- aktuator ----------
bool alarmEligible() {
  return sensorOk && mqtt.connected() && !serverOffline() && tareState == "READY" && devState == "READY" && waterStatus.length();
}

String effectiveLed() {
  if (!sensorOk || !mqtt.connected() || serverOffline()) return "ERROR_PULSE";
  if (tareState != "READY") return "STANDBY";
  return ledMode;
}

bool ledLevel(const String& m, unsigned long t) {
  if (m == "ON") return true;
  if (m == "SLOW_BLINK") return (t % 2000) < 1000;
  if (m == "FAST_BLINK") return (t % 400) < 200;
  if (m == "ERROR_PULSE") { unsigned long p = t % 5000; return p < 600 && (p % 200) < 100; }  // 3 pulsa cepat / 5 dtk
  if (m == "STANDBY") return (t % 2000) < 100;
  return false;
}

void tickActuators() {
  unsigned long now = millis();
  digitalWrite(LED_PIN, ledLevel(effectiveLed(), now) ? HIGH : LOW);

  if (!alarmEligible()) {  // OFFLINE/ERROR/TARE: peringatan air dihentikan
    beepsLeft = 0; alarmStatus = "";
    if (buzzOn) { buzzerSet(false); buzzOn = false; }
    return;
  }
  if (waterStatus != alarmStatus) {  // transisi status: bunyi sekali, lalu ulangi sesuai interval
    alarmStatus = waterStatus;
    if (beepsCfg > 0) { startBeeps(beepsCfg); nextRepeatMs = now + (unsigned long)repeatSec * 1000UL; }
  } else if (beepsCfg > 0 && repeatSec > 0 && beepsLeft == 0 && now >= nextRepeatMs) {
    startBeeps(beepsCfg); nextRepeatMs = now + (unsigned long)repeatSec * 1000UL;
  }
  if (beepsLeft > 0 && now >= buzzNextMs) {  // 200 ms ON / 200 ms OFF
    if (!buzzOn) { buzzerSet(true); buzzOn = true; }
    else { buzzerSet(false); buzzOn = false; beepsLeft--; }
    buzzNextMs = now + 200;
  }
}

void updateDisplay() {
  if (!sensorOk) lcdShow("SENSOR ERROR", "Cek kabel HX711");
  else if (tareState == "FAILED") lcdShow("TARE GAGAL", tareError);
  else if (tareState != "READY") lcdShow("TARE REQUIRED", "Tare via web");
  else if (!mqtt.connected()) lcdShow("KONEKSI OFFLINE", WiFi.status() == WL_CONNECTED ? "MQTT putus" : "Wi-Fi putus");
  else if (serverOffline()) lcdShow("SERVER OFFLINE", "Alarm dihentikan");
  else if (devState == "READY" && pctF >= 0) lcdShow("V:" + String(volumeL, 2) + "L " + String((int)roundf(pctF)) + "%", waterStatus + " ONL");
  else if (devState == "SENSOR_ERROR") lcdShow("SENSOR ERROR", "(menurut Worker)");
  else lcdShow("MENUNGGU WORKER", devState);
}

// ---------- setup / loop ----------
void setup() {
  Serial.begin(115200);
  pinMode(LED_PIN, OUTPUT);
#ifndef WOKWI
  pinMode(BUZZER_PIN, OUTPUT);
#endif
  buzzerSet(false);

  snprintf(bootId, sizeof(bootId), "%04X", (unsigned)(esp_random() & 0xFFFF));

  Wire.begin(LCD_SDA, LCD_SCL);
  lcd.init(); lcd.backlight();
  lcdShow("SMART DISPENSER", "Boot " + String(bootId));

  scale.begin(HX711_DT, HX711_SCK);
  scale.set_scale(CAL_FACTOR);
#ifndef WOKWI
  if (CAL_FACTOR == 1.0f) Serial.println("PERINGATAN: CAL_FACTOR=1.0, nilai belum dalam kg. Kalibrasi dulu.");
#endif

  // F-05: offset tare bertahan setelah restart; ESP32 tidak men-tare otomatis (P10).
  prefs.begin("water-scale", false);
  lastCmd = prefs.getString("lastCmd", "");
  if (prefs.getBool("hasOffset", false)) {
    scale.set_offset(prefs.getLong("offset", 0));
    tareId = prefs.getString("tareId", "");
    tareState = "READY";
    lastAck = tareId;
    Serial.printf("[NVS] offset dimuat, tare_id=%s\n", tareId.c_str());
  }

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
#if USE_TLS
  // shortcut: sertifikat broker tidak diverifikasi; pasang CA (net.setCACert) sebelum dipakai di luar demo.
  net.setInsecure();
#endif
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setBufferSize(768);
  mqtt.setSocketTimeout(5);
  mqtt.setCallback(onMessage);
}

void loop() {
  unsigned long now = millis();

  if (WiFi.status() != WL_CONNECTED) {
    if (now - lastWifiTry > 10000) { lastWifiTry = now; WiFi.reconnect(); }
  } else if (!mqtt.connected() && now - lastMqttTry > 5000) {
    lastMqttTry = now;
    Serial.println(connectMqtt() ? "[MQTT] terhubung" : "[MQTT] gagal, coba lagi");
  }
  mqtt.loop();

  if (pendingTare.length()) { String id = pendingTare; pendingTare = ""; doTare(id); }

  if (now - lastReadMs >= READ_MS) { lastReadMs = now; readSensor(); }
  if (now - lastPublishMs >= PUBLISH_MS) { lastPublishMs = now; publishRaw(); }  // juga saat sensor error (sensor_ok=false)
  if (now - lastLcdMs >= 500) { lastLcdMs = now; updateDisplay(); }

  tickActuators();
  delay(10);
}
