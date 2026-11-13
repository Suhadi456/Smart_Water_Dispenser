'use strict';
process.env.CONFIRM_SAMPLES = '2';
const test = require('node:test');
const assert = require('node:assert/strict');
const w = require('../waterService');

const TH = { habis: 4, kritis: 10, rendah: 20 };
const fresh = () => ({ confirmed: null, pending: null, count: 0 });

test('classify: batas inklusif sesuai Bab 5.5', () => {
  assert.equal(w.classify(4, TH), 'HABIS');
  assert.equal(w.classify(4.1, TH), 'KRITIS');
  assert.equal(w.classify(10, TH), 'KRITIS');
  assert.equal(w.classify(20, TH), 'RENDAH');
  assert.equal(w.classify(20.1, TH), 'NORMAL');
});

test('classify: tabel 5 L dan 10 L (default) cocok dengan laporan', () => {
  const st = (kg, cap) => w.classify(w.measure(kg, cap).pct, TH);
  assert.deepEqual([0.2, 0.5, 1.0, 1.01].map((k) => st(k, 5)), ['HABIS', 'KRITIS', 'RENDAH', 'NORMAL']);
  assert.deepEqual([0.4, 1.0, 2.0, 2.01].map((k) => st(k, 10)), ['HABIS', 'KRITIS', 'RENDAH', 'NORMAL']);
});

test('measure: 1 kg = 1 L, clamp, dan anomali', () => {
  assert.deepEqual(w.measure(3.5, 5), { volume: 3.5, pct: 70, anomaly: false });
  assert.deepEqual(w.measure(-0.03, 5), { volume: 0, pct: 0, anomaly: false });
  assert.equal(w.measure(5.8, 5).pct, 100);
  assert.equal(w.measure(5.8, 5).anomaly, false);
  assert.equal(w.measure(6.5, 5).anomaly, true);
  assert.equal(w.measure(-2, 5).anomaly, true);
});

test('confirm: sampel pertama langsung dipakai; perubahan butuh 2 sampel berurutan', () => {
  const t = fresh();
  assert.equal(w.confirm(t, 70, TH), false);
  assert.equal(t.confirmed, 'NORMAL');
  assert.equal(w.confirm(t, 15, TH), false); // 1 sampel RENDAH
  assert.equal(t.confirmed, 'NORMAL');
  assert.equal(w.confirm(t, 15, TH), true); // sampel ke-2
  assert.equal(t.confirmed, 'RENDAH');
});

test('confirm: sampel tunggal berbeda (noise) tidak mengubah status', () => {
  const t = fresh();
  w.confirm(t, 70, TH);
  w.confirm(t, 15, TH);
  w.confirm(t, 70, TH); // kembali normal: pending dibatalkan
  assert.equal(w.confirm(t, 15, TH), false);
  assert.equal(t.confirmed, 'NORMAL');
});

test('confirm: hysteresis 1 poin saat kembali ke level lebih baik', () => {
  const t = fresh();
  w.confirm(t, 3, TH); // HABIS
  // 4.5% secara mentah KRITIS, tetapi di bawah batas+1 (5%) -> tetap HABIS
  w.confirm(t, 4.5, TH);
  w.confirm(t, 4.5, TH);
  assert.equal(t.confirmed, 'HABIS');
  w.confirm(t, 5.5, TH);
  assert.equal(w.confirm(t, 5.5, TH), true);
  assert.equal(t.confirmed, 'KRITIS');
});

test('confirm: memburuk tidak kena hysteresis', () => {
  const t = fresh();
  w.confirm(t, 21, TH); // NORMAL
  w.confirm(t, 19.9, TH);
  assert.equal(w.confirm(t, 19.9, TH), true);
  assert.equal(t.confirmed, 'RENDAH');
});

test('actuators: kebijakan LED/buzzer Bab 5.6', () => {
  assert.deepEqual(w.actuators('READY', 'NORMAL'), { led: 'OFF', beeps: 0, repeat: 0 });
  assert.deepEqual(w.actuators('READY', 'RENDAH'), { led: 'SLOW_BLINK', beeps: 1, repeat: 600 });
  assert.deepEqual(w.actuators('READY', 'KRITIS'), { led: 'FAST_BLINK', beeps: 2, repeat: 300 });
  assert.deepEqual(w.actuators('READY', 'HABIS'), { led: 'ON', beeps: 3, repeat: 120 });
  assert.equal(w.actuators('SENSOR_ERROR', null).beeps, 0);
  assert.equal(w.actuators('TARE_REQUIRED', null).beeps, 0);
});

test('hourBucket: berganti pada pergantian jam UTC', () => {
  const a = w.hourBucket(new Date('2026-01-01T10:59:59Z'));
  assert.equal(w.hourBucket(new Date('2026-01-01T10:00:00Z')), a);
  assert.equal(w.hourBucket(new Date('2026-01-01T11:00:00Z')), a + 1);
});

