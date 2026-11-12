-- Smart Water Dispenser: 2 tabel (Laporan Arsitektur Bab 6.1-6.3).
-- Dijalankan oleh `npm run db:init` (backend/). Tabel dibuat di database yang sedang dipilih.
-- Kolom di luar tabel laporan (sensor_ok, latest_percentage, tare_requested_at, tare_message)
-- ditambahkan karena dibutuhkan UX Bab 6.6 (SENSOR_ERROR, persen, timeout/penyebab tare gagal).

CREATE TABLE IF NOT EXISTS devices (
  id                    INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  device_code           VARCHAR(40)  NOT NULL UNIQUE,
  capacity_liter        TINYINT UNSIGNED NOT NULL DEFAULT 5,
  threshold_habis_pct   TINYINT UNSIGNED NOT NULL DEFAULT 4,
  threshold_kritis_pct  TINYINT UNSIGNED NOT NULL DEFAULT 10,
  threshold_rendah_pct  TINYINT UNSIGNED NOT NULL DEFAULT 20,
  config_version        INT UNSIGNED NOT NULL DEFAULT 1,
  tare_state            VARCHAR(16)  NOT NULL DEFAULT 'TARE_REQUIRED',
  tare_id               VARCHAR(32)  NULL,
  tare_requested_at     DATETIME(3)  NULL,
  tare_message          VARCHAR(160) NULL,
  sensor_ok             TINYINT(1)   NOT NULL DEFAULT 1,
  latest_volume_liter   DECIMAL(6,2) NULL,
  latest_percentage     DECIMAL(5,1) NULL,
  latest_water_status   VARCHAR(10)  NULL,
  connection_state      VARCHAR(10)  NOT NULL DEFAULT 'UNKNOWN',
  last_raw_at           DATETIME(3)  NULL,
  latest_at             DATETIME(3)  NULL,
  latest_boot_id        VARCHAR(32)  NULL,
  latest_seq            INT UNSIGNED NULL,
  CONSTRAINT chk_capacity   CHECK (capacity_liter IN (5, 10)),
  CONSTRAINT chk_thresholds CHECK (threshold_habis_pct < threshold_kritis_pct
                               AND threshold_kritis_pct < threshold_rendah_pct
                               AND threshold_rendah_pct < 100),
  CONSTRAINT chk_tare_state CHECK (tare_state IN ('TARE_REQUIRED','TARE_IN_PROGRESS','READY','TARE_FAILED'))
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS water_readings (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  device_id        INT UNSIGNED NOT NULL,
  boot_id          VARCHAR(32)  NULL,  -- NULL: baris dari perubahan konfigurasi, bukan sampel ESP32
  seq              INT UNSIGNED NULL,
  tare_id          VARCHAR(32)  NULL,
  config_version   INT UNSIGNED NOT NULL,
  water_weight_kg  DECIMAL(7,3) NULL,
  capacity_liter   TINYINT UNSIGNED NOT NULL,
  volume_liter     DECIMAL(6,2) NULL,
  percentage       DECIMAL(5,1) NULL,
  water_status     VARCHAR(10)  NULL,
  device_state     VARCHAR(20)  NOT NULL,
  record_reason    VARCHAR(16)  NOT NULL,
  recorded_at      DATETIME(3)  NOT NULL,  -- UTC
  CONSTRAINT fk_readings_device FOREIGN KEY (device_id) REFERENCES devices(id),
  CONSTRAINT chk_reason CHECK (record_reason IN ('HOURLY','STATUS_CHANGE','DEVICE_EVENT')),
  UNIQUE KEY uq_sample (device_id, boot_id, seq),
  KEY idx_device_time (device_id, recorded_at)
) ENGINE=InnoDB;

INSERT IGNORE INTO devices (device_code) VALUES ('dispenser-001');

