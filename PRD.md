# Product Requirements Document (PRD)
## Smart Water Dispenser Level and Refill Alert System

**Versi:** 1.0  
**Tanggal:** 16 November 2026  
**Basis Proyek:** Laporan Arsitektur IoT, Laporan Simulator Wokwi (Paket C), dan kode aktual pada direktori `iot/`.

---

## 1. Ringkasan Produk

Smart Water Dispenser Level and Refill Alert System memantau sisa air galon (`5 L` atau `10 L`) secara real-time menggunakan sensor beban pada dispenser bersama (ruang kerja, laboratorium, atau hunian). Pengguna dapat mengganti galon dengan berat wadah kosong yang berbeda tanpa mengubah kode server melalui prosedur tare manual terkontrol dari web dashboard. Seluruh perhitungan volume, persentase, status air, histori, dan perintah aktuator diproses terpusat oleh Node.js Worker melalui protokol MQTT.

---

## 2. Tujuan & Metrik Keberhasilan

| Aspek | Target |
| :--- | :--- |
| Akurasi pengukuran | Error volume target awal `±0,10 L` pada titik uji stabil (diverifikasi dengan wadah ukur / timbangan pembanding). |
| Respons pembaruan | Target arsitektur `<= 45` detik end-to-end; implementasi saat ini memakai interval publish `2` detik dan polling web `1` detik. |
| Konsistensi tare | Pergantian galon `5 L` ↔ `10 L` wajib membatalkan status lama hingga tare galon kosong terkonfirmasi ACK. |
| Efisiensi histori | Tabel `water_readings` hanya menyimpan sampel saat pergantian jam (`HOURLY`), perubahan status (`STATUS_CHANGE`), atau event perangkat (`DEVICE_EVENT`). |
| Kejelasan gangguan | Kondisi `SENSOR_ERROR`, `OFFLINE`, dan data kedaluwarsa (`> 30` detik) tampil terpisah dan tidak pernah dilaporkan sebagai `HABIS`. |

---

## 3. Ruang Lingkup & Batasan

### Termasuk dalam Ruang Lingkup (In-Scope)
- Pemantauan **1 unit dispenser** (`dispenser-001`) dengan 1 ESP32, 1 platform timbangan Load Cell 20 kg + HX711, LCD I2C 16×2, LED merah, dan buzzer.
- Dukungan kapasitas galon tepat **`5 L`** atau **`10 L`**.
- Kalibrasi titik nol (**tare**) manual melalui konfirmasi pengguna pada dashboard, dengan penyimpanan offset persisten di memori NVS ESP32 (`Preferences.h`).
- Pengaturan dinamis batas persentase status (`HABIS`, `KRITIS`, `RENDAH`, `NORMAL`) langsung dari dashboard tanpa upload ulang firmware.
- Dashboard web tunggal responsif (HP & desktop) tanpa login, menampilkan visualisasi galon, metrik real-time, grafik `24 JAM` / `7 HARI`, dan panel kontrol.
- Skrip uji unit, uji end-to-end dengan broker MQTT lokal + simulator ESP32, serta firmware ESP32 untuk broker lokal maupun EMQX Cloud TLS.

### Di Luar Ruang Lingkup (Out-of-Scope)
- Sistem login/autentikasi pengguna, multi-user, dan manajemen banyak dispenser.
- Tabel atau daftar riwayat pengisian ulang manual (`refill_history`).
- Aktuator pompa air otomatis atau audio streaming pada buzzer.
- Layanan hosting cloud 24 jam berbayar (pemrosesan berjalan di laptop Windows + XAMPP MySQL; akses publik sementara memakai Cloudflare Quick Tunnel).

---

## 4. Arsitektur Sistem (4 Layer IoT)

1. **Perception Layer (`esp32/dispenser/dispenser.ino`)**
   - Membaca HX711 setiap `1` detik dengan filter median `5` sampel.
   - Memublikasikan payload `raw` ke MQTT (interval `2` detik di firmware saat ini; target laporan `10` detik).
   - Menyimpan offset tare dan `lastCmd` di NVS (`water-scale`) agar tahan restart tanpa men-tare ulang galon berisi.
   - Menjalankan perintah tare, LCD 16×2 (`0x27`), pola kedipan LED, dan bunyi buzzer sesuai instruksi dari Worker; beralih ke `SERVER OFFLINE` dan menghentikan alarm jika `> 30` detik tanpa status valid.
2. **Network Layer (MQTT Broker)**
   - Menggunakan 3 topic untuk `dispenser-001`:
     - `dispenser/001/raw` (ESP32 → Worker, QoS 0, non-retain)
     - `dispenser/001/status` (Worker → ESP32, QoS 1, non-retain)
     - `dispenser/001/availability` (ESP32 online / Broker LWT offline, QoS 0/1, retain `true`)
   - Mendukung mode lokal tanpa TLS (`mqtt://127.0.0.1:1883` via `backend/scripts/devBroker.js`) dan mode cloud TLS (`mqtts://<host>.emqxsl.com:8883` via EMQX Cloud Serverless).
3. **Processing Layer (`backend/` & `database/`)**
   - `mqttWorker.js`: memvalidasi payload, menjaga idempotensi `boot_id`/`seq`/`tare_id`, menghitung keputusan lewat `waterService.js`, mengelola state tare lewat `tareService.js`, memublikasikan `status`, dan menulis ke MySQL (`database.js`).
   - `server.js` & `routes/apiRoutes.js`: menyajikan REST API (`/api/*`), melayani file statis `frontend/`, dan menerapkan pembatasan laju permintaan (`10` req/menit/IP pada endpoint mutasi).
4. **Application Layer (`frontend/`)**
   - Dashboard HTML/CSS/JS murni (`index.html`, `css/style.css`, `js/dashboard.js`) yang melakukan polling ke REST API Express tanpa koneksi langsung ke broker MQTT.

---

## 5. Kebutuhan Fungsional

| ID | Kebutuhan | Pelaksana | Aturan & Kriteria Penerimaan |
| :--- | :--- | :--- | :--- |
| **F-01** | Pembacaan berat berkala | ESP32 | Membaca Load Cell + HX711 tiap `1` detik; menyaring noise dengan median `5` sampel. |
| **F-02** | Pengiriman telemetri `raw` | ESP32 | Mengirim JSON berisi `device_id`, `boot_id`, `seq`, `water_weight_kg`, `sensor_ok`, `tare_state`, `tare_id`, `last_command_ack`. |
| **F-03** | Pemilihan kapasitas galon | Dashboard → API → DB | Hanya menerima `5` atau `10` liter; mengubah kapasitas menaikkan `config_version`, mengosongkan snapshot volume/status, dan menetapkan `tare_state = TARE_REQUIRED`. |
| **F-04** | Prosedur tare manual | Dashboard → Worker → ESP32 | Membutuhkan `confirm_empty: true`; menghasilkan `tare_id` unik (`tare-0001`, dst.), menetapkan `TARE_IN_PROGRESS`, mengirim `command: {"type":"TARE","id":"..."}`, dan menjadi `READY` hanya setelah ACK `last_command_ack` cocok serta sensor valid. |
| **F-05** | Persistensi offset tare | ESP32 NVS | Offset tersimpan di `Preferences`; saat restart tanpa ganti galon, offset dipulihkan dan ESP32 tidak men-tare otomatis. |
| **F-06** | Perhitungan volume & status | Node.js Worker | `V_liter = max(0, water_weight_kg / 1.0)`, `Persentase = clamp(100 * V_liter / C_liter, 0, 100)`. Berat `< -1 kg` atau `> C_liter + 1 kg` ditandai anomali (`SENSOR_ERROR`). |
| **F-07** | Ambang status dinamis | Dashboard → API → Worker | Validasi server-side `0 <= H < K < R < 100` (default `H=4`, `K=10`, `R=20`). Perubahan menaikkan `config_version` dan memicu evaluasi ulang sampel valid terakhir. |
| **F-08** | Kendali aktuator terpusat | Worker → ESP32 | Worker mengirim `led_mode`, `buzzer_beeps`, dan `buzzer_repeat_sec` pada topic `status` sesuai tabel kebijakan Bab 6. |
| **F-09** | Tampilan lokal & dashboard | ESP32 LCD & Web | Menampilkan volume (`L`), persentase (`%`), status air, kapasitas (`5`/`10 L`), kesegaran data (`data_fresh`), dan status koneksi (`ONLINE`/`OFFLINE`). |
| **F-10** | Penyimpanan snapshot & histori | Worker → MySQL | Snapshot di `devices` diperbarui tiap sampel valid; `water_readings` hanya mencatat event `HOURLY`, `STATUS_CHANGE`, atau `DEVICE_EVENT` dalam waktu UTC. |
| **F-11** | Grafik historis | Dashboard | Menampilkan grafik SVG `24h` atau `7d` berdasarkan `recorded_at` asli, garis kapasitas bertangga, dan memutus kurva saat jeda data `> 2,5` jam tanpa interpolasi. |
| **F-12** | Ketahanan gangguan & duplikasi | ESP32 & Worker | Menolak JSON rusak, `NaN`/non-finis, `boot_id`/`seq` lama, `device_id` salah, `tare_id` tidak cocok; menandai timeout tare setelah `60` detik tanpa ACK menjadi `TARE_FAILED`. |

---

## 6. Logika Klasifikasi, Hysteresis, dan Aktuator

### Ambang Status Air & Kebijakan Aktuator
| Status | Aturan Persentase (`P`) | Batas Default 5 L | Batas Default 10 L | `led_mode` | `buzzer_beeps` / Ulang |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `HABIS` | `P <= H` (4%) | `<= 0,20 L` | `<= 0,40 L` | `ON` | `3` bunyi / `120` detik |
| `KRITIS` | `H < P <= K` (10%) | `> 0,20 – 0,50 L` | `> 0,40 – 1,00 L` | `FAST_BLINK` (200 ms) | `2` bunyi / `300` detik |
| `RENDAH` | `K < P <= R` (20%) | `> 0,50 – 1,00 L` | `> 1,00 – 2,00 L` | `SLOW_BLINK` (1 dtk) | `1` bunyi / `600` detik |
| `NORMAL` | `P > R` (>20%) | `> 1,00 L` | `> 2,00 L` | `OFF` | `0` (mati) |
| `SENSOR_ERROR` / Offline | `sensor_ok = false` atau anomali | — | — | `ERROR_PULSE` (3 pulsa/5 dtk) | `0` (peringatan dihentikan) |
| `TARE_REQUIRED` / `TARE_IN_PROGRESS` | Menunggu atau sedang tare | — | — | `STANDBY` | `0` (peringatan dihentikan) |

**Peredam Noise:** `waterService.js` menerapkan hysteresis `1` poin persentase saat level membaik. Parameter `CONFIRM_SAMPLES` dapat disetel ke `2` (melalui variabel lingkungan `CONFIRM_SAMPLES=2`) untuk konfirmasi dua sampel berurutan sesuai rancangan awal laporan, atau dibiarkan `1` (default saat ini) untuk respons pembaruan instan.

---

## 7. Skema Database & Kontrak REST API

### Database MySQL (`database/schema.sql`)
1. **`devices`**: menyimpan `device_code`, `capacity_liter`, `threshold_habis_pct`, `threshold_kritis_pct`, `threshold_rendah_pct`, `config_version`, `tare_state`, `tare_id`, `tare_requested_at`, `tare_message`, `sensor_ok`, `latest_volume_liter`, `latest_percentage`, `latest_water_status`, `connection_state`, `last_raw_at`, `latest_at`, `latest_boot_id`, `latest_seq`.
2. **`water_readings`**: menyimpan histori dengan FK ke `devices(id)`, `UNIQUE KEY uq_sample (device_id, boot_id, seq)`, dan `KEY idx_device_time (device_id, recorded_at)`.

### REST API (`backend/routes/apiRoutes.js`)
| Metode | Endpoint | Fungsi | Validasi & Keamanan |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/monitoring` | Snapshot status perangkat, volume, persentase, `data_fresh` (`<= 30` dtk), koneksi | Menjalankan cek timeout tare otomatis |
| `GET` | `/api/readings?range=24h\|7d` | Titik data grafik historis bernilai valid | Menolak `range` selain `24h` dan `7d` (`400`) |
| `GET` | `/api/device` | Konfigurasi aktif dan status tare | — |
| `PATCH` | `/api/device` | Ubah kapasitas (`5`/`10`) dan ambang batas | Bilangan bulat, `0 <= H < K < R < 100`, rate limit `10/mnt` |
| `POST` | `/api/tare` | Kirim perintah tare baru | Wajib `confirm_empty: true`, tolak jika `TARE_IN_PROGRESS` (`409`), rate limit `10/mnt` |
| `GET` | `/api/tare` | Status dan pesan tare terakhir | — |

---

## 8. Aturan UX Dashboard (`frontend/`)

1. **`READY` + `ONLINE` + data segar**: Menampilkan visualisasi galon, angka volume (`L`), persentase (`%`), status air, kebijakan LED/buzzer, kapasitas aktif, dan waktu pembaruan terakhir.
2. **`TARE_REQUIRED`**: Menampilkan peringatan butuh tare, menonaktifkan tampilan volume/status dari galon lama, dan mengarahkan pengguna menekan **TARE GALON KOSONG**.
3. **`TARE_IN_PROGRESS`**: Menampilkan indikator proses aktif dan menonaktifkan tombol tare hingga ACK diterima atau timeout.
4. **`TARE_FAILED`**: Menampilkan pesan penyebab kegagalan dan membuka kembali tombol tare untuk percobaan ulang.
5. **`SENSOR_ERROR` / `OFFLINE` / data lama**: Menampilkan banner peringatan eksplisit, menandai kartu sebagai `DATA LAMA`, dan tidak mengonversi error sensor menjadi `HABIS`.
6. **Ganti `5 L` ↔ `10 L`**: Menyesuaikan skala persentase dan konversi batas liter pada form, sambil menjaga data histori lama tetap merujuk pada `capacity_liter` saat data direkam.

---

## 9. Kebutuhan Nonfungsional

- **Keamanan Operasional (NF-03, NF-04)**: Kredensial database dan MQTT disimpan di `backend/.env` (dikecualikan oleh `.gitignore`); input API dibatasi ukuran JSON `2kb`, divalidasi tipe/rentangnya di server, dan dibatasi rate limit. Mode demo tidak memakai login sehingga tunnel publik wajib dimatikan setelah pengujian.
- **Modularitas & Keterujian (NF-07)**: Logika perhitungan (`waterService.js`), alur tare (`tareService.js`), akses database (`database.js`), worker MQTT (`mqttWorker.js`), dan rute API (`apiRoutes.js`) dipisah agar dapat diuji mandiri.
- **Responsivitas & Aksesibilitas**: Tata letak adaptif untuk layar ponsel (`<= 540px`) dan desktop, mendukung mode terang/gelap, target sentuh minimal `40–44px`, dan menghormati `prefers-reduced-motion`.

---

## 10. Status Pengujian & Kesiapan

- **Terverifikasi secara otomatis:**
  - Unit test `npm test` (`backend/test/water.test.js`): 9 kasus uji mencakup klasifikasi, konversi, anomali, konfirmasi, hysteresis, aktuator, dan partisi jam UTC.
  - Uji integrasi end-to-end `npm run test:e2e` (`backend/test/e2e.js`): menguji alur broker MQTT lokal, Worker, MySQL (`smart_water_test`), REST API, idempotensi tare, pergantian `5 L` → `10 L`, `SENSOR_ERROR`, LWT `OFFLINE`, dan rate limit.
  - Uji antarmuka JSDOM (`verify_ui.js`): memastikan render DOM, siluet galon, pembaruan grafik SVG, dan pergantian tema berjalan tanpa error JavaScript.
- **Belum terverifikasi di hardware akhir:**
  - Kompilasi dan kalibrasi `esp32/dispenser/dispenser.ino` pada perangkat ESP32 fisik dengan nilai `CAL_FACTOR` aktual (`94.2222f` dari uji hardware test), koneksi EMQX Cloud TLS port `8883`, serta pengujian akurasi massa `0,5 / 1 / 3 / 5 / 10 L` di platform akrilik.

