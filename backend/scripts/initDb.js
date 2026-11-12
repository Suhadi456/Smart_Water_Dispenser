'use strict';
// Membuat database (bila belum ada) lalu menjalankan ../database/schema.sql.
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const config = require('../config');

(async () => {
  const { database, ...conn } = config.db;
  const schema = fs.readFileSync(path.join(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');
  const c = await mysql.createConnection({ ...conn, multipleStatements: true });
  // Nama database divalidasi karena dipakai sebagai identifier.
  if (!/^\w+$/.test(database)) throw new Error(`DB_NAME tidak valid: ${database}`);
  if (process.argv.includes('--reset')) {
    if (!database.endsWith('_test')) throw new Error('--reset hanya diizinkan untuk database berakhiran _test');
    await c.query(`DROP DATABASE IF EXISTS \`${database}\``);
  }
  await c.query(`CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4`);
  await c.query(`USE \`${database}\``);
  await c.query(schema);
  console.log(`Database '${database}' siap.`);
  await c.end();
})().catch((e) => {
  console.error('db:init gagal:', e.message);
  process.exit(1);
});

