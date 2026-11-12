'use strict';
const mysql = require('mysql2/promise');
const config = require('./config');

// timezone 'Z': semua DATETIME dibaca/ditulis sebagai UTC (Bab 6.2 recorded_at UTC).
const pool = mysql.createPool({ ...config.db, timezone: 'Z', connectionLimit: 5, decimalNumbers: true });

async function getDevice() {
  const [rows] = await pool.query('SELECT * FROM devices WHERE device_code = ?', [config.deviceCode]);
  return rows[0] || null;
}

// Nama kolom hanya berasal dari kode server (bukan input pengguna).
async function updateDevice(id, patch) {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  const set = keys.map((k) => `\`${k}\` = ?`).join(', ');
  await pool.query(`UPDATE devices SET ${set} WHERE id = ?`, [...keys.map((k) => patch[k]), id]);
}

async function insertReading(row) {
  const keys = Object.keys(row);
  await pool.query(
    `INSERT INTO water_readings (${keys.map((k) => `\`${k}\``).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
    keys.map((k) => row[k]),
  );
}

module.exports = { pool, getDevice, updateDevice, insertReading };

