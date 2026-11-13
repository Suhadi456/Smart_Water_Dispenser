'use strict';
// Rumus & keputusan status air (Laporan Arsitektur Bab 5.4-5.6). Fungsi murni agar mudah diuji.

const LEVEL = { HABIS: 0, KRITIS: 1, RENDAH: 2, NORMAL: 3 };
const HYSTERESIS_PCT = 1;     // Bab 5.5: 1 poin persentase saat kembali ke level lebih baik
const CONFIRM_SAMPLES = Number(process.env.CONFIRM_SAMPLES) || 1;    // 1 agar status instan (dapat diubah ke 2 jika ingin noise filter ekstra)
const ANOMALY_MARGIN_KG = 1;  // asumsi: berat > kapasitas+1 kg atau < -1 kg dianggap anomali (Bab 5.4 hanya bilang "selisih signifikan")

const ACTUATORS = {
  NORMAL: { led: 'OFF', beeps: 0, repeat: 0 },
  RENDAH: { led: 'SLOW_BLINK', beeps: 1, repeat: 600 },
  KRITIS: { led: 'FAST_BLINK', beeps: 2, repeat: 300 },
  HABIS: { led: 'ON', beeps: 3, repeat: 120 },
};

const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d;

// Bab 5.5: HABIS P<=H, KRITIS H<P<=K, RENDAH K<P<=R, NORMAL P>R
function classify(pct, th) {
  if (pct <= th.habis) return 'HABIS';
  if (pct <= th.kritis) return 'KRITIS';
  if (pct <= th.rendah) return 'RENDAH';
  return 'NORMAL';
}

// Bab 5.4: 1 kg = 1 L; persentase di-clamp 0..100
function measure(weightKg, capacity) {
  const volume = Math.max(0, weightKg);
  const pct = Math.min(100, (100 * volume) / capacity);
  return {
    volume: round(volume, 2),
    pct: round(pct, 1),
    anomaly: weightKg > capacity + ANOMALY_MARGIN_KG || weightKg < -ANOMALY_MARGIN_KG,
  };
}

// track = { confirmed, pending, count }. Mengubah track; true bila status terkonfirmasi berubah.
function confirm(track, pct, th) {
  let target = classify(pct, th);
  if (track.confirmed == null) {
    Object.assign(track, { confirmed: target, pending: null, count: 0 });
    return false;
  }
  if (LEVEL[target] > LEVEL[track.confirmed]) {
    const damped = classify(pct - HYSTERESIS_PCT, th);
    target = LEVEL[damped] > LEVEL[track.confirmed] ? damped : track.confirmed;
  }
  if (target === track.confirmed) {
    track.pending = null;
    track.count = 0;
    return false;
  }
  track.count = target === track.pending ? track.count + 1 : 1;
  track.pending = target;
  if (track.count < CONFIRM_SAMPLES) return false;
  Object.assign(track, { confirmed: target, pending: null, count: 0 });
  return true;
}

// Bab 5.6. Pola STANDBY/ERROR_PULSE untuk kondisi non-air (Bab 5.6 baris OFFLINE/ERROR dan TARE_*).
function actuators(deviceState, waterStatus) {
  if (deviceState === 'READY') return ACTUATORS[waterStatus] || ACTUATORS.NORMAL;
  if (deviceState === 'SENSOR_ERROR') return { led: 'ERROR_PULSE', beeps: 0, repeat: 0 };
  return { led: 'STANDBY', beeps: 0, repeat: 0 };
}

const hourBucket = (date) => Math.floor(date.getTime() / 3600000);

module.exports = { classify, measure, confirm, actuators, hourBucket, HYSTERESIS_PCT, CONFIRM_SAMPLES };

