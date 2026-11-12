# Smart Water Dispenser Level & Refill Alert System

Implementasi sistem 4 layer IoT sesuai laporan arsitektur dan simulasi Wokwi:
- `database/schema.sql`: Skema 2 tabel MySQL (`devices`, `water_readings`).
- `backend/`: Express REST API + Node.js MQTT Worker (`waterService.js`, `tareService.js`, `mqttWorker.js`).
- `frontend/`: Dashboard tunggal responsif tanpa login (`index.html`, `css/style.css`, `js/dashboard.js`).
- `esp32/`: Firmware ESP32 siap MQTT TLS (`dispenser/dispenser.ino`) + rangkaian Wokwi (`wokwi/diagram.json`, `wokwi/libraries.txt`).

## 1. Persiapan & Inisialisasi Database (XAMPP MySQL)

Pastikan modul **MySQL** di XAMPP Control Panel aktif (`localhost:3306`), lalu jalankan di folder `backend/`:

```powershell
cd backend
npm install
npm run db:init
```

## 2. Menjalankan Secara Lokal (Tanpa Akun EMQX)

Konfigurasi bawaan `.env` memakai broker lokal `mqtt://127.0.0.1:1883`:

1. Terminal 1 — jalankan broker MQTT lokal:
   ```powershell
   npm run broker
   ```
2. Terminal 2 — jalankan server API + Worker + Dashboard:
   ```powershell
   npm start
   ```
3. Terminal 3 (opsional) — jalankan emulator ESP32 interaktif:
   ```powershell
   npm run simulate
   ```
   Perintah simulator: `w <kg>` (ubah berat), `err` / `ok` (sensor error), `failtare`, `crash`, `q`.
4. Buka `http://localhost:3000` di browser.

## 3. Menghubungkan ke EMQX Cloud & Wokwi / ESP32 Fisik

1. Di EMQX Cloud Serverless: buat deployment, catat alamat broker (`*.emqxsl.com`, port `8883`), lalu buat username & password pada menu **Access Control -> Authentication**.
2. Ubah `backend/.env`:
   ```env
   MQTT_URL=mqtts://<host>.emqxsl.com:8883
   MQTT_USERNAME=<username>
   MQTT_PASSWORD=<password>
   ```
3. Ubah `esp32/dispenser/dispenser.ino` pada bagian `MQTT_HOST`, `MQTT_USER`, dan `MQTT_PASS`.
   - Untuk **Wokwi**: biarkan `#define WOKWI 1`, salin `dispenser.ino`, `wokwi/diagram.json`, dan `wokwi/libraries.txt` ke proyek Wokwi ESP32.
   - Untuk **perangkat fisik**: komentari `#define WOKWI 1`, isi `WIFI_SSID`/`WIFI_PASS`, dan kalibrasi `CAL_FACTOR` dengan massa referensi.
4. (Opsional untuk demo publik): jalankan Cloudflare Quick Tunnel ke `http://localhost:3000`, dan matikan tunnel setelah sesi selesai karena dashboard tidak memakai login.

## 4. Pengujian

```powershell
npm test       # Unit test rumus, klasifikasi, hysteresis, aktuator
npm run test:e2e   # End-to-end (broker + Worker + MySQL smart_water_test + API + simulator)
```

