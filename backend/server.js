'use strict';
const path = require('path');
const express = require('express');
const config = require('./config');
const db = require('./database');
const { startWorker } = require('./mqttWorker');
const apiRoutes = require('./routes/apiRoutes');

function start(port = config.port) {
  const worker = startWorker();
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback'); // IP asli klien di balik cloudflared (untuk rate limit)
  app.use('/api', apiRoutes({ worker }));
  app.use(express.static(path.join(__dirname, '..', 'frontend')));

  return new Promise((resolve) => {
    const server = app.listen(port, () => {
      console.log(`Dashboard: http://localhost:${server.address().port}`);
      resolve({
        server,
        worker,
        close: async () => {
          await new Promise((r) => server.close(r));
          await worker.stop();
          await db.pool.end();
        },
      });
    });
  });
}

if (require.main === module) start();
module.exports = { start };
