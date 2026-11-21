// Local trusted development code, executed in a separate process (not a sandbox).
const Module = require('node:module');
const path = require('node:path');
process.once('message', async ({ source, event }) => {
  try {
    const filename = path.join(__dirname, 'local-function.cjs');
    const mod = new Module(filename, module);
    mod.filename = filename;
    mod.paths = Module._nodeModulePaths(__dirname);
    mod._compile(source, filename);
    if (typeof mod.exports.handler !== 'function') throw new Error('Export an async function as exports.handler.');
    const started = Date.now();
    const result = await mod.exports.handler(event, {
      functionName: process.env.LOCAL_FUNCTION_NAME,
      awsRequestId: require('node:crypto').randomUUID(),
      getRemainingTimeInMillis: () => Math.max(0, Number(process.env.LAMBDA_TIMEOUT_MS || 10000) - (Date.now() - started)),
    });
    process.send({ result: result === undefined ? null : result });
  } catch (error) {
    process.send({ error: error.stack || String(error) });
  }
});
