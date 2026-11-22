require('dotenv').config({ quiet: true });
const { createApp } = require('./server');
const port = Number(process.env.PORT || 8001);
const app = createApp();
const server = app.listen(port, process.env.HOST || '127.0.0.1', () => {
  console.log(`Local AWS Console: http://127.0.0.1:${port}`);
  console.log('State is persisted in SQLite; Docker databases and registry use persistent volumes.');
});
const closeTerminals = app.locals.attachTerminal(server);
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  closeTerminals();
  server.close(() => { app.locals.close(); process.exit(0); });
  setTimeout(() => process.exit(1), 15000).unref();
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
