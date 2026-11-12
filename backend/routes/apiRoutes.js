'use strict';
// REST API dashboard tanpa login (Laporan Bab 6.4).
const express = require('express');
const config = require('../config');
const db = require('../database');
const tare = require('../tareService');

const RANGES = { '24h': 24 * 3600e3, '7d': 7 * 24 * 3600e3 };

// shortcut: jendela tetap per proses & per IP, bukan sliding window; upgrade ke express-rate-limit bila perlu.
function limiter(max, windowMs) {
  let hits = new Map();
  setInterval(() => (hits = new Map()), windowMs).unref();
  return (req, res, next) => {
    const n = (hits.get(req.ip) || 0) + 1;
    hits.set(req.ip, n);
    if (n > max) return res.status(429).json({ error: 'Terlalu banyak permintaan. Coba lagi sebentar.' });
    next();
  };
}

const iso = (d) => (d ? d.toISOString() : null);
const thresholds = (d) => ({
  threshold_habis_pct: d.threshold_habis_pct,
  threshold_kritis_pct: d.threshold_kritis_pct,
  threshold_rendah_pct: d.threshold_rendah_pct,
});
const deviceView = (d) => ({
  device_code: d.device_code,
  capacity_liter: d.capacity_liter,
  ...thresholds(d),
  config_version: d.config_version,
  tare_state: d.tare_state,
  tare_id: d.tare_id,
});
const tareView = (d) => ({
  tare_state: d.tare_state,
  tare_id: d.tare_id,
  tare_message: d.tare_message,
  requested_at: iso(d.tare_requested_at),
});

async function currentDevice() {
  return tare.checkTimeout(await db.getDevice());
}

module.exports = ({ worker }) => {
  const r = express.Router();
  r.use(express.json({ limit: '2kb' })); // di dalam router agar error parse ditangani handler di bawah
  const mutate = limiter(config.rateLimitPerMin, 60e3);
  const sync = async () => {
    try { await worker.republish(); } catch { /* tidak boleh menggagalkan respons API */ }
  };

  r.get('/monitoring', async (req, res) => {
    const d = await currentDevice();
    const age = d.last_raw_at ? Date.now() - d.last_raw_at.getTime() : null;
    const fresh = age !== null && age <= config.freshSec * 1000;
    res.json({
      ...deviceView(d),
      device_state: d.tare_state !== 'READY' ? d.tare_state : d.sensor_ok ? 'READY' : 'SENSOR_ERROR',
      volume_liter: d.latest_volume_liter,
      percentage: d.latest_percentage,
      water_status: d.latest_water_status,
      tare_message: d.tare_message,
      connection: d.connection_state === 'ONLINE' && fresh ? 'ONLINE' : 'OFFLINE',
      data_fresh: fresh,
      last_raw_at: iso(d.last_raw_at),
      latest_at: iso(d.latest_at),
      server_time: new Date().toISOString(),
    });
  });

  // Hanya titik bernilai dengan timestamp aslinya; tanpa interpolasi (Bab 6.3 butir 3).
  r.get('/readings', async (req, res) => {
    const span = RANGES[req.query.range];
    if (!span) return res.status(400).json({ error: "range harus '24h' atau '7d'." });
    const d = await db.getDevice();
    const [rows] = await db.pool.query(
      `SELECT recorded_at, volume_liter, percentage, water_status, capacity_liter, record_reason
         FROM water_readings
        WHERE device_id = ? AND recorded_at >= ? AND volume_liter IS NOT NULL
        ORDER BY recorded_at`,
      [d.id, new Date(Date.now() - span)],
    );
    res.json({ range: req.query.range, readings: rows.map((x) => ({ ...x, recorded_at: iso(x.recorded_at) })) });
  });

  r.get('/device', async (req, res) => res.json(deviceView(await currentDevice())));

  r.patch('/device', mutate, async (req, res) => {
    const d = await tare.changeConfig(req.body ?? {});
    await sync();
    res.json(deviceView(d));
  });

  r.get('/tare', async (req, res) => res.json(tareView(await currentDevice())));

  r.post('/tare', mutate, async (req, res) => {
    if (req.body?.confirm_empty !== true) throw tare.fail(400, 'Konfirmasi bahwa galon benar-benar kosong diperlukan.');
    await tare.requestTare();
    await sync();
    res.status(202).json(tareView(await db.getDevice()));
  });

  r.use((req, res) => res.status(404).json({ error: 'Endpoint tidak ditemukan.' }));

  // eslint-disable-next-line no-unused-vars
  r.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') {
      return res.status(400).json({ error: 'Body JSON tidak valid.' });
    }
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error(new Date().toISOString(), '[api]', err.message);
    const dbDown = ['ECONNREFUSED', 'PROTOCOL_CONNECTION_LOST', 'ER_ACCESS_DENIED_ERROR', 'ER_BAD_DB_ERROR'].includes(err.code);
    res.status(dbDown ? 503 : 500).json({ error: dbDown ? 'Database tidak tersedia.' : 'Kesalahan server.' });
  });

  return r;
};
