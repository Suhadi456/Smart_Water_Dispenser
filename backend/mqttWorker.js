'use strict';
// Node.js Worker (Laporan Bab 4.6): subscribe raw/availability, hitung status, publish status, simpan histori.
const mqtt = require('mqtt');
const config = require('./config');
const db = require('./database');
const water = require('./waterService');
const tare = require('./tareService');

const T = {
  raw: `${config.topicPrefix}/raw`,
  status: `${config.topicPrefix}/status`,
  avail: `${config.topicPrefix}/availability`,
};
const log = (...a) => console.log(new Date().toISOString(), '[worker]', ...a);
const TARE_STATES = ['READY', 'TARE_REQUIRED', 'FAILED'];
const optStr = (v) => v == null || (typeof v === 'string' && v.length <= 32);

// Bab 5.3: tolak payload rusak / nilai nonfinis. (JSON.parse sudah menolak NaN/Infinity.)
function parseRaw(buf) {
  let r;
  try {
    r = JSON.parse(buf);
  } catch {
    return log('raw ditolak: JSON rusak'), null;
  }
  const w = r?.water_weight_kg;
  const ok =
    r && typeof r === 'object' &&
    typeof r.device_id === 'string' &&
    typeof r.boot_id === 'string' && r.boot_id.length > 0 && r.boot_id.length <= 32 &&
    Number.isInteger(r.seq) && r.seq >= 0 && r.seq <= 4294967295 &&
    typeof r.sensor_ok === 'boolean' &&
    TARE_STATES.includes(r.tare_state) &&
    optStr(r.tare_id) && optStr(r.last_command_ack) &&
    (r.sensor_ok ? typeof w === 'number' && Number.isFinite(w) : w == null || Number.isFinite(w));
  return ok ? r : (log('raw ditolak: skema/nilai tidak valid'), null);
}

function startWorker() {
  if (!config.mqtt.url) {
    log('MQTT_URL kosong: MQTT nonaktif (API + dashboard tetap berjalan).');
    return { republish: async () => {}, stop: async () => {} };
  }

  const track = { confirmed: null, pending: null, count: 0 };
  const resetTrack = () => Object.assign(track, { confirmed: null, pending: null, count: 0 });
  let trackVersion = null;
  let lastValid = null; // sampel valid terakhir: dipakai untuk evaluasi ulang saat ambang berubah (Bab 5.5)
  let lastBucket = null; // jam (UTC) terakhir yang punya baris histori bernilai
  let cache = null; // salinan baris devices, dipakai bila MySQL sedang mati (Bab 5.7)
  // shortcut: instruction_id berbasis detik epoch agar tetap naik setelah restart Worker; upgrade bila perlu persist.
  let instruction = Math.floor(Date.now() / 1000);
  let queue = Promise.resolve();

  const enqueue = (fn) => (queue = queue.then(fn).catch((e) => log('error:', e.message)));

  const client = mqtt.connect(config.mqtt.url, {
    username: config.mqtt.username,
    password: config.mqtt.password,
    clientId: `smart-water-worker-${config.deviceCode}`,
    reconnectPeriod: 3000,
    connectTimeout: 10000,
  });
  client.on('connect', () => {
    log('MQTT terhubung ke', config.mqtt.url);
    client.subscribe(T.raw, { qos: 0 });
    client.subscribe(T.avail, { qos: 1 });
  });
  client.on('error', (e) => log('MQTT error:', e.message));
  client.on('offline', () => log('MQTT offline, mencoba lagi...'));
  client.on('message', (topic, buf) =>
    enqueue(() => (topic === T.raw ? handleRaw(buf) : topic === T.avail ? handleAvailability(buf) : null)));

  db.pool
    .query('SELECT MAX(recorded_at) AS m FROM water_readings WHERE volume_liter IS NOT NULL')
    .then(([[row]]) => { if (row.m) lastBucket = water.hourBucket(row.m); })
    .catch((e) => log('MySQL belum siap saat start:', e.message));

  async function loadDevice() {
    try {
      const d = await db.getDevice();
      if (d) cache = await tare.checkTimeout(d);
    } catch (e) {
      log('MySQL tidak tersedia, memakai cache:', e.message);
    }
    return cache;
  }

  async function save(dev, patch) {
    const merged = { ...dev, ...patch };
    try {
      await db.updateDevice(dev.id, patch);
    } catch (e) {
      log('gagal simpan snapshot:', e.message);
    }
    cache = merged;
    return merged;
  }

  async function record(dev, out, reason, sample, at) {
    const row = {
      device_id: dev.id,
      boot_id: sample?.boot_id ?? null,
      seq: sample?.seq ?? null,
      tare_id: dev.tare_id,
      config_version: dev.config_version,
      water_weight_kg: Number.isFinite(sample?.weight) ? sample.weight : null,
      capacity_liter: dev.capacity_liter,
      volume_liter: out.volume ?? null,
      percentage: out.pct ?? null,
      water_status: out.status ?? null,
      device_state: out.state,
      record_reason: reason,
      recorded_at: at,
    };
    try {
      await db.insertReading(row);
      if (row.volume_liter != null) lastBucket = water.hourBucket(at);
    } catch (e) {
      log('gagal simpan histori:', e.message);
    }
  }

  function publishStatus(dev, replySeq, out) {
    if (!client.connected || !dev.latest_boot_id) return;
    const a = water.actuators(out.state, out.status);
    client.publish(T.status, JSON.stringify({
      device_id: dev.device_code,
      boot_id: dev.latest_boot_id,
      reply_to_seq: replySeq,
      instruction_id: ++instruction,
      config_version: dev.config_version,
      device_state: out.state,
      volume_liter: out.volume ?? null,
      percentage: out.pct ?? null,
      water_status: out.status ?? null,
      led_mode: a.led,
      buzzer_beeps: a.beeps,
      buzzer_repeat_sec: a.repeat,
      // Perintah dikirim ulang pada setiap balasan selama IN_PROGRESS; ESP32 idempoten lewat command.id.
      command: out.state === 'TARE_IN_PROGRESS' ? { type: 'TARE', id: dev.tare_id } : null,
    }), { qos: 1, retain: false });
  }

  // Menghitung status dari sampel valid; mengisi patch snapshot. Mengembalikan keputusan.
  function evaluate(dev, s, patch) {
    if (dev.config_version !== trackVersion) {
      resetTrack();
      trackVersion = dev.config_version;
    }
    const m = s.sensor_ok ? water.measure(s.weight, dev.capacity_liter) : null;
    if (!m || m.anomaly) {
      resetTrack();
      lastValid = null;
      Object.assign(patch, { sensor_ok: 0, latest_volume_liter: null, latest_percentage: null, latest_water_status: null });
      return { state: 'SENSOR_ERROR', reason: dev.sensor_ok ? 'DEVICE_EVENT' : null };
    }
    const changed = water.confirm(track, m.pct, {
      habis: dev.threshold_habis_pct,
      kritis: dev.threshold_kritis_pct,
      rendah: dev.threshold_rendah_pct,
    });
    lastValid = { boot_id: s.boot_id, seq: s.seq, weight: s.weight };
    Object.assign(patch, {
      sensor_ok: 1,
      latest_volume_liter: m.volume,
      latest_percentage: m.pct,
      latest_water_status: track.confirmed,
      latest_at: s.at,
    });
    const reason = changed ? 'STATUS_CHANGE' : !dev.sensor_ok || dev.tare_state !== 'READY' ? 'DEVICE_EVENT' : null;
    return { state: 'READY', volume: m.volume, pct: m.pct, status: track.confirmed, reason };
  }

  async function finish(dev, patch, out, sample, replySeq, at) {
    // Bab 6.3: satu baris per pergantian jam; alasan peristiwa mengalahkan HOURLY.
    const reason = out.reason || (out.state === 'READY' && water.hourBucket(at) !== lastBucket ? 'HOURLY' : null);
    const merged = await save(dev, patch);
    if (reason) await record(merged, out, reason, sample, at);
    publishStatus(merged, replySeq, out);
  }

  async function handleRaw(buf) {
    const raw = parseRaw(buf);
    if (!raw) return;
    let dev = await loadDevice();
    if (!dev) return log('raw diabaikan: perangkat belum ada di database');
    if (raw.device_id !== dev.device_code) return log('raw ditolak: device_id salah:', raw.device_id);
    if (raw.boot_id === dev.latest_boot_id && raw.seq <= dev.latest_seq)
      return log('raw ditolak: duplikat/lama', raw.boot_id, raw.seq);

    const at = new Date();
    const patch = { last_raw_at: at, latest_boot_id: raw.boot_id, latest_seq: raw.seq, connection_state: 'ONLINE' };
    let event = false;

    if (dev.tare_state === 'TARE_IN_PROGRESS') {
      const ack = tare.ackResult(dev, raw);
      if (ack) {
        Object.assign(patch, { tare_state: ack.state, tare_message: ack.message ?? null });
        event = true;
        resetTrack();
        lastValid = null;
      }
    } else if (dev.tare_state === 'READY') {
      if (raw.tare_state !== 'READY') {
        Object.assign(patch, { tare_state: 'TARE_REQUIRED', tare_message: 'ESP32 tidak memiliki offset tare. Lakukan tare galon kosong.' });
        event = true;
        resetTrack();
        lastValid = null;
      } else if (raw.tare_id !== dev.tare_id) {
        return log('raw ditolak: tare_id tidak cocok', raw.tare_id, '!=', dev.tare_id);
      }
    }

    const state = patch.tare_state || dev.tare_state;
    const sample = { boot_id: raw.boot_id, seq: raw.seq, weight: raw.water_weight_kg ?? null, sensor_ok: raw.sensor_ok, at };
    const out = state === 'READY'
      ? evaluate(dev, sample, patch)
      : { state, reason: event ? 'DEVICE_EVENT' : null };
    await finish(dev, patch, out, sample, raw.seq, at);
  }

  async function handleAvailability(buf) {
    let m;
    try {
      m = JSON.parse(buf);
    } catch {
      return log('availability ditolak: JSON rusak');
    }
    const st = { online: 'ONLINE', offline: 'OFFLINE' }[m?.connection];
    if (m?.device_id !== config.deviceCode || !st) return;
    const dev = await loadDevice();
    if (dev) await save(dev, { connection_state: st });
    log('availability:', st);
  }

  // Dipanggil API setelah konfigurasi/tare berubah: kirim instruksi baru tanpa menunggu raw berikutnya (Bab 5.3).
  function republish() {
    return enqueue(async () => {
      const dev = await loadDevice();
      if (!dev?.latest_boot_id) return; // belum ada sesi ESP32 yang bisa dituju
      if (dev.tare_state !== 'READY') {
        resetTrack();
        lastValid = null;
        return publishStatus(dev, dev.latest_seq, { state: dev.tare_state });
      }
      if (!lastValid || lastValid.boot_id !== dev.latest_boot_id) return; // balasan berikutnya menyusul dari raw
      const patch = {};
      const at = new Date();
      const out = evaluate(dev, { ...lastValid, sensor_ok: true, at: dev.latest_at || at }, patch);
      await finish(dev, patch, out, null, lastValid.seq, at);
    });
  }

  return {
    republish,
    stop: async () => {
      await queue;
      await new Promise((resolve) => client.end(false, {}, resolve));
    },
  };
}

module.exports = { startWorker };

