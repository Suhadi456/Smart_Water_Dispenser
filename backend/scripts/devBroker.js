'use strict';
// Broker MQTT lokal untuk uji tanpa internet/EMQX (tanpa TLS, tanpa autentikasi). JANGAN dipakai untuk produksi.
const net = require('net');

async function startBroker(port = 1883) {
  const { Aedes } = await import('aedes'); // aedes adalah paket ESM
  const aedes = await Aedes.createBroker();
  const server = net.createServer(aedes.handle);
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    close: async () => {
      await new Promise((r) => server.close(r));
      await new Promise((r) => aedes.close(r));
    },
  };
}

if (require.main === module) {
  startBroker(Number(process.env.BROKER_PORT) || 1883).then((b) =>
    console.log(`Broker MQTT lokal di mqtt://127.0.0.1:${b.port}`));
}
module.exports = { startBroker };

