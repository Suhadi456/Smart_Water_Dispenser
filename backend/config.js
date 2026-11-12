'use strict';
const fs = require('fs');
const path = require('path');

// Variabel lingkungan yang sudah ada (mis. dari test) tidak ditimpa oleh .env.
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
const e = process.env;

module.exports = {
  port: Number(e.PORT) || 3000,
  deviceCode: e.DEVICE_CODE || 'dispenser-001',
  topicPrefix: e.MQTT_TOPIC_PREFIX || 'dispenser/001',
  mqtt: { url: e.MQTT_URL || '', username: e.MQTT_USERNAME || undefined, password: e.MQTT_PASSWORD || undefined },
  db: {
    host: e.DB_HOST || '127.0.0.1',
    port: Number(e.DB_PORT) || 3306,
    user: e.DB_USER || 'root',
    password: e.DB_PASSWORD || '',
    database: e.DB_NAME || 'smart_water',
  },
  freshSec: Number(e.FRESH_SEC) || 30,            // data dianggap lama bila raw terakhir lebih tua dari ini
  tareTimeoutSec: Number(e.TARE_TIMEOUT_SEC) || 60, // tare tanpa ACK selewat ini dianggap gagal
  rateLimitPerMin: Number(e.RATE_LIMIT_PER_MIN) || 10, // endpoint yang mengubah data
};

