'use strict';
// Emulator ESP32 yang menirukan protokol firmware (raw/status/availability, tare + ACK, LWT).
// Dipakai untuk uji end-to-end & demo dashboard tanpa perangkat. CLI: npm run simulate
const mqtt = require('mqtt');
const config = require('../config');

function createSimulator({ url = config.mqtt.url, prefix = config.topicPrefix, deviceId = config.deviceCode, intervalMs = 10000 } = {}) {
  const T = { raw: `${prefix}/raw`, status: `${prefix}/status`, avail: `${prefix}/availability` };
  const bootId = Math.floor(Math.random() * 0xffff).toString(16).toUpperCase().padStart(4, '0');
  const sim = {
    weight: 0, sensorOk: true, failNextTare: false,
    tareState: 'TARE_REQUIRED', tareId: null, ack: null, tareError: null,
    seq: 0, lastInstruction: 0, lastCmd: null,
    tareRuns: {},        // command.id -> berapa kali tare dieksekusi (harus 1: idempotensi)
    lastStatus: null,    // instruksi Worker terakhir yang diterapkan
  };
  const will = JSON.stringify({ device_id: deviceId, connection: 'offline' });
  const client = mqtt.connect(url, {
    username: config.mqtt.username, password: config.mqtt.password,
    clientId: `sim-${deviceId}-${bootId}`, reconnectPeriod: 0,
    will: { topic: T.avail, payload: will, qos: 1, retain: true },
  });

  const publishRaw = () => {
    if (!client.connected) return;
    sim.seq += 1;
    const raw = {
      device_id: deviceId, boot_id: bootId, seq: sim.seq,
      water_weight_kg: sim.sensorOk ? Math.round(sim.weight * 100) / 100 : null,
      sensor_ok: sim.sensorOk, tare_state: sim.tareState,
      tare_id: sim.tareId, last_command_ack: sim.ack,
    };
    if (sim.tareState === 'FAILED') raw.tare_error = sim.tareError;
    client.publish(T.raw, JSON.stringify(raw), { qos: 0 });
  };

  client.on('connect', () => {
    client.publish(T.avail, JSON.stringify({ device_id: deviceId, connection: 'online' }), { qos: 0, retain: true });
    client.subscribe(T.status, { qos: 1 });
    publishRaw();
  });
  client.on('error', (e) => console.error('[sim] error:', e.message));

  client.on('message', (topic, buf) => {
    let m;
    try { m = JSON.parse(buf); } catch { return; }
    if (m.device_id !== deviceId || m.boot_id !== bootId) return;
    if (!(m.instruction_id > sim.lastInstruction)) return; // duplikat/lama (Bab 5.3)
    sim.lastInstruction = m.instruction_id;
    sim.lastStatus = m;
    const cmd = m.command;
    if (cmd?.type === 'TARE' && cmd.id !== sim.lastCmd) {
      sim.lastCmd = cmd.id;
      sim.tareRuns[cmd.id] = (sim.tareRuns[cmd.id] || 0) + 1;
      sim.tareId = cmd.id;
      if (sim.failNextTare) {
        sim.failNextTare = false;
        Object.assign(sim, { tareState: 'FAILED', ack: null, tareError: 'Berat tidak stabil' });
      } else {
        Object.assign(sim, { tareState: 'READY', ack: cmd.id, tareError: null });
        sim.weight = 0; // galon kosong ditimbang ulang menjadi nol
      }
      publishRaw(); // ACK segera, tidak menunggu siklus berikutnya
    }
  });

  const timer = setInterval(publishRaw, intervalMs);
  return Object.assign(sim, {
    client,
    stop: () => { clearInterval(timer); return new Promise((r) => client.end(false, {}, r)); },
    crash: () => { clearInterval(timer); client.stream.destroy(); }, // putus tanpa DISCONNECT -> broker kirim LWT
  });
}

if (require.main === module) {
  const sim = createSimulator();
  console.log('Simulator ESP32. Perintah: w <kg> | err | ok | failtare | crash | q');
  require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
    const [c, v] = line.trim().split(/\s+/);
    if (c === 'w') sim.weight = Number(v);
    else if (c === 'err') sim.sensorOk = false;
    else if (c === 'ok') sim.sensorOk = true;
    else if (c === 'failtare') sim.failNextTare = true;
    else if (c === 'crash') sim.crash();
    else if (c === 'q') sim.stop().then(() => process.exit(0));
    else return console.log('perintah tidak dikenal');
    console.log(`berat=${sim.weight} sensor_ok=${sim.sensorOk} tare=${sim.tareState}`);
  });
}
module.exports = { createSimulator };

