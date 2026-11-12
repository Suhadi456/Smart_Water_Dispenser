'use strict';
// Uji end-to-end: broker lokal + Worker + Express + MySQL (database *_test) + emulator ESP32.
// Prasyarat: MySQL XAMPP berjalan. Jalankan: npm run test:e2e
Object.assign(process.env, {
  DB_NAME: 'smart_water_test',
  MQTT_URL: 'mqtt://127.0.0.1:18830',
  FRESH_SEC: '2',
  RATE_LIMIT_PER_MIN: '30',
});
const assert = require('node:assert/strict');
const path = require('path');
const { execFileSync } = require('child_process');

execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'initDb.js'), '--reset'], { stdio: 'inherit' });

const db = require('../database');
const { startBroker } = require('../scripts/devBroker');
const { createSimulator } = require('../scripts/simulator');
const { start } = require('../server');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(desc, fn, ms = 10000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout menunggu: ${desc}`);
    await sleep(100);
  }
}

(async () => {
  const broker = await startBroker(18830);
  const app = await start(0);
  const base = `http://127.0.0.1:${app.server.address().port}/api`;
  const get = async (p) => (await fetch(base + p)).json();
  const send = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const mon = () => get('/monitoring');
  const waitMon = (desc, pred) => until(desc, async () => { const m = await mon(); return pred(m) && m; });
  const step = async (name, fn) => { await fn(); console.log('  ok  ' + name); };

  const sim = createSimulator({ url: process.env.MQTT_URL, intervalMs: 200 });

  await step('perangkat online, belum tare -> TARE_REQUIRED tanpa volume', async () => {
    const m = await waitMon('online', (x) => x.connection === 'ONLINE');
    assert.equal(m.tare_state, 'TARE_REQUIRED');
    assert.equal(m.volume_liter, null);
    assert.equal(m.water_status, null);
  });

  await step('validasi API publik (I12)', async () => {
    assert.equal((await send('POST', '/tare', {})).status, 400);
    assert.equal((await send('PATCH', '/device', { capacity_liter: 3 })).status, 400);
    assert.equal((await send('PATCH', '/device', { threshold_habis_pct: 10, threshold_kritis_pct: 5 })).status, 400);
    assert.equal((await send('PATCH', '/device', { threshold_rendah_pct: 100 })).status, 400);
    assert.equal((await send('PATCH', '/device', { threshold_habis_pct: 1.5 })).status, 400);
    assert.equal((await send('PATCH', '/device', {})).status, 400);
    assert.equal((await fetch(base + '/readings?range=1y')).status, 400);
  });

  await step('tare galon kosong: ACK cocok -> READY, perintah dieksekusi sekali (I04)', async () => {
    sim.weight = 0.5; // massa galon kosong
    assert.equal((await send('POST', '/tare', { confirm_empty: true })).status, 202);
    await waitMon('READY', (x) => x.tare_state === 'READY');
    assert.equal(sim.tareRuns['tare-0001'], 1);
  });

  await step('NORMAL 3,5 L = 70% (I01/I02)', async () => {
    sim.weight = 3.5;
    const m = await waitMon('NORMAL', (x) => x.water_status === 'NORMAL' && x.volume_liter === 3.5);
    assert.equal(m.percentage, 70);
    assert.equal(m.device_state, 'READY');
    await until('led OFF', () => sim.lastStatus?.led_mode === 'OFF' && sim.lastStatus.volume_liter === 3.5);
  });

  for (const [kg, status, led, beeps] of [[0.8, 'RENDAH', 'SLOW_BLINK', 1], [0.4, 'KRITIS', 'FAST_BLINK', 2], [0.1, 'HABIS', 'ON', 3]]) {
    await step(`${kg} kg -> ${status}, LED ${led}, ${beeps} bunyi (I06)`, async () => {
      sim.weight = kg;
      await waitMon(status, (x) => x.water_status === status);
      await until('instruksi aktuator', () => sim.lastStatus?.water_status === status);
      assert.equal(sim.lastStatus.led_mode, led);
      assert.equal(sim.lastStatus.buzzer_beeps, beeps);
    });
  }

  await step('ambang diubah dari dashboard dipakai Worker tanpa reflash (I05)', async () => {
    sim.weight = 1.2; // 24% -> NORMAL pada ambang bawaan
    const before = await waitMon('NORMAL', (x) => x.water_status === 'NORMAL');
    const r = await send('PATCH', '/device', { threshold_habis_pct: 5, threshold_kritis_pct: 15, threshold_rendah_pct: 30 });
    assert.equal(r.status, 200);
    assert.equal(r.body.config_version, before.config_version + 1);
    const m = await waitMon('RENDAH baru', (x) => x.water_status === 'RENDAH');
    assert.equal(m.config_version, before.config_version + 1);
    await until('instruksi versi baru', () => sim.lastStatus?.config_version === m.config_version);
  });

  await step('ganti 5 L -> 10 L: kapasitas berubah, tare wajib, status lama tidak dipakai (I03)', async () => {
    const r = await send('PATCH', '/device', { capacity_liter: 10 });
    assert.equal(r.status, 200);
    const m = await waitMon('TARE_REQUIRED', (x) => x.tare_state === 'TARE_REQUIRED');
    assert.equal(m.capacity_liter, 10);
    assert.equal(m.volume_liter, null);
    assert.equal(m.water_status, null);
    await until('status ke ESP32', () => sim.lastStatus?.device_state === 'TARE_REQUIRED');
    assert.equal(sim.lastStatus.command, null);
  });

  await step('tare gagal -> TARE_FAILED dengan penyebab; coba ulang berhasil', async () => {
    sim.failNextTare = true;
    await send('POST', '/tare', { confirm_empty: true });
    const m = await waitMon('TARE_FAILED', (x) => x.tare_state === 'TARE_FAILED');
    assert.equal(m.volume_liter, null);
    assert.match(m.tare_message, /tidak stabil/);
    assert.equal((await get('/tare')).tare_state, 'TARE_FAILED');
    await send('POST', '/tare', { confirm_empty: true });
    await waitMon('READY lagi', (x) => x.tare_state === 'READY');
    assert.ok(Object.keys(sim.tareRuns).length >= 3);
    assert.ok(Object.values(sim.tareRuns).every((n) => n === 1));
  });

  await step('command.id yang sama dikirim ulang tidak dieksekusi dua kali (I04)', async () => {
    const dup = { ...sim.lastStatus, instruction_id: sim.lastStatus.instruction_id + 1, command: { type: 'TARE', id: sim.lastCmd } };
    sim.client.publish(`${process.env.MQTT_TOPIC_PREFIX || 'dispenser/001'}/status`, JSON.stringify(dup), { qos: 1 });
    await sleep(600);
    assert.equal(sim.tareRuns[sim.lastCmd], 1);
  });

  await step('galon 10 L: 5 kg = 50% NORMAL', async () => {
    sim.weight = 5;
    const m = await waitMon('NORMAL 10L', (x) => x.water_status === 'NORMAL' && x.volume_liter === 5);
    assert.equal(m.percentage, 50);
  });

  await step('sensor error / anomali -> SENSOR_ERROR, bukan HABIS (NF-06)', async () => {
    sim.sensorOk = false;
    const m = await waitMon('SENSOR_ERROR', (x) => x.device_state === 'SENSOR_ERROR');
    assert.equal(m.volume_liter, null);
    assert.equal(m.water_status, null);
    await until('LED error', () => sim.lastStatus?.device_state === 'SENSOR_ERROR');
    assert.equal(sim.lastStatus.led_mode, 'ERROR_PULSE');
    assert.equal(sim.lastStatus.buzzer_beeps, 0);
    sim.sensorOk = true;
    await waitMon('pulih', (x) => x.device_state === 'READY');
    sim.weight = 20; // jauh di atas kapasitas 10 L -> anomali
    await waitMon('anomali', (x) => x.device_state === 'SENSOR_ERROR');
    sim.weight = 5;
    await waitMon('pulih', (x) => x.device_state === 'READY' && x.volume_liter === 5);
  });

  await step('histori: jarang (bukan per sampel), punya alasan, kapasitas asli 5 L & 10 L (I07-I09)', async () => {
    const { readings } = await get('/readings?range=24h');
    assert.ok(readings.length >= 4, `hanya ${readings.length} baris`);
    // Uji ini cuma beberapa detik: tanpa HOURLY berulang, baris hanya dari peristiwa (tidak satu baris per sampel).
    assert.ok(readings.length < sim.seq, `${readings.length} baris untuk ${sim.seq} sampel`);
    assert.ok(readings.filter((x) => x.record_reason === 'HOURLY').length <= 1);
    assert.ok(readings.some((x) => x.record_reason === 'STATUS_CHANGE'));
    assert.deepEqual([...new Set(readings.map((x) => x.capacity_liter))].sort((a, b) => a - b), [5, 10]);
    assert.equal((await get('/readings?range=7d')).readings.length, readings.length);
    const [[dupes]] = await db.pool.query('SELECT COUNT(*) n FROM (SELECT 1 FROM water_readings WHERE seq IS NOT NULL GROUP BY boot_id, seq HAVING COUNT(*) > 1) d');
    assert.equal(dupes.n, 0);
  });

  await step('perangkat mati mendadak -> OFFLINE, nilai terakhir tidak dipalsukan jadi 0', async () => {
    sim.crash();
    const m = await waitMon('OFFLINE + data lama', (x) => x.connection === 'OFFLINE' && !x.data_fresh);
    assert.equal(m.data_fresh, false);
    assert.equal(m.volume_liter, 5);
  });

  await step('rate limit pada endpoint yang mengubah data (I12)', async () => {
    const codes = [];
    for (let i = 0; i < 40; i++) codes.push((await send('PATCH', '/device', { capacity_liter: 3 })).status);
    assert.ok(codes.includes(429), 'tidak ada 429');
    assert.equal(codes[0], 400);
  });

  await app.close();
  await broker.close();
  console.log('\nSEMUA UJI END-TO-END LULUS');
  process.exit(0);
})().catch((e) => {
  console.error('\nUJI GAGAL:', e.message);
  process.exit(1);
});
