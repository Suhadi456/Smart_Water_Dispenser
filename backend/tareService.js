'use strict';
// Permintaan tare, ACK, pergantian kapasitas/ambang (Laporan Bab 4.7 & 6.4).
const db = require('./database');
const config = require('./config');

const fail = (status, message) => Object.assign(new Error(message), { status });
const nextTareId = (cur) => {
  const m = /^tare-(\d+)$/.exec(cur || '');
  return `tare-${String((m ? Number(m[1]) : 0) + 1).padStart(4, '0')}`;
};

// Tare tanpa ACK melewati batas waktu -> TARE_FAILED (mis. ESP32 mati saat tare diminta).
async function checkTimeout(dev) {
  if (dev.tare_state !== 'TARE_IN_PROGRESS') return dev;
  if (Date.now() - dev.tare_requested_at.getTime() <= config.tareTimeoutSec * 1000) return dev;
  const patch = {
    tare_state: 'TARE_FAILED',
    tare_message: 'Timeout: ESP32 tidak mengonfirmasi tare. Pastikan perangkat online, lalu coba lagi.',
  };
  await db.updateDevice(dev.id, patch);
  return { ...dev, ...patch };
}

// Bab 4.7 langkah 5: READY hanya bila ACK memuat ID perintah yang cocok dan sensor valid.
function ackResult(dev, raw) {
  if (raw.tare_id !== dev.tare_id) return null;
  if (raw.tare_state === 'FAILED') return { state: 'TARE_FAILED', message: raw.tare_error || 'Tare gagal di ESP32.' };
  if (raw.tare_state === 'READY' && raw.last_command_ack === dev.tare_id && raw.sensor_ok) return { state: 'READY' };
  return null;
}

async function requestTare() {
  const dev = await checkTimeout(await db.getDevice());
  if (dev.tare_state === 'TARE_IN_PROGRESS') throw fail(409, 'Tare sedang berjalan.');
  const id = nextTareId(dev.tare_id);
  await db.updateDevice(dev.id, {
    tare_state: 'TARE_IN_PROGRESS',
    tare_id: id,
    tare_requested_at: new Date(),
    tare_message: null,
    latest_volume_liter: null,
    latest_percentage: null,
    latest_water_status: null,
  });
  return id;
}

const isInt = (v) => Number.isInteger(v);

async function changeConfig(body) {
  const dev = await db.getDevice();
  const next = {
    capacity_liter: body.capacity_liter ?? dev.capacity_liter,
    threshold_habis_pct: body.threshold_habis_pct ?? dev.threshold_habis_pct,
    threshold_kritis_pct: body.threshold_kritis_pct ?? dev.threshold_kritis_pct,
    threshold_rendah_pct: body.threshold_rendah_pct ?? dev.threshold_rendah_pct,
  };
  const keys = Object.keys(next);
  if (!keys.some((k) => body[k] !== undefined)) throw fail(400, 'Tidak ada field konfigurasi yang dikirim.');
  if (!keys.every((k) => isInt(next[k]))) throw fail(400, 'Semua nilai harus bilangan bulat.');
  if (![5, 10].includes(next.capacity_liter)) throw fail(400, 'Kapasitas hanya boleh 5 atau 10 liter.');
  const { threshold_habis_pct: h, threshold_kritis_pct: k, threshold_rendah_pct: r } = next;
  if (!(h >= 0 && h < k && k < r && r < 100)) throw fail(400, 'Batas harus memenuhi 0 ≤ HABIS < KRITIS < RENDAH < 100.');

  if (keys.every((key) => next[key] === dev[key])) return dev;
  const patch = { ...next, config_version: dev.config_version + 1 };
  if (next.capacity_liter !== dev.capacity_liter) {
    // Bab 4.7 langkah 1: ganti kapasitas -> status galon lama tidak boleh dipakai sampai tare ulang.
    Object.assign(patch, {
      tare_state: 'TARE_REQUIRED',
      tare_message: null,
      latest_volume_liter: null,
      latest_percentage: null,
      latest_water_status: null,
    });
  }
  await db.updateDevice(dev.id, patch);
  return { ...dev, ...patch };
}

module.exports = { fail, checkTimeout, ackResult, requestTare, changeConfig };

