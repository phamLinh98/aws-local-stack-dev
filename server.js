const express = require('express');
const path = require('node:path');
const crypto = require('node:crypto');
const { fork } = require('node:child_process');

const clone = value => structuredClone(value);
const md5 = value => crypto.createHash('md5').update(value).digest('hex');
const xml = value => String(value).replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[c]));
const fail = (message, name = 'ValidationException', status = 400) => { throw Object.assign(new Error(message), { name, status }); };
const nameOf = value => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_.-]{1,128}$/.test(value)) fail('Use a name with 1–128 letters, numbers, dots, underscores or hyphens.');
  return value;
};
const demoSource = `exports.handler = async (event) => {\n  console.log('Received event:', JSON.stringify(event));\n  return {\n    statusCode: 200,\n    body: JSON.stringify({ message: 'Hello from local Lambda!', input: event })\n  };\n};\n`;

function createApp() {
  const app = express();
  let tables, buckets, queues, secrets, functions;
  let activity = [];
  let activeInvocations = 0;
  const record = (service, action, resource, status = 'success') => {
    activity.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), service, action, resource, status });
    activity = activity.slice(0, 100);
  };
  function seed() {
    tables = new Map(); buckets = new Map(); queues = new Map(); secrets = new Map(); functions = new Map();
    tables.set(process.env.UPLOAD_CSV_TABLE_NAME || 'uploadCsvTableName', { keys: ['id'], items: [
      { id: { S: '1fab83f3-5260-43d7-afb2-f33cc596896c' }, name: { S: 'Item 1' }, status: { S: 'Pending' } },
      { id: { S: '234' }, name: { S: 'Item 2' }, status: { S: 'Pending' } },
    ] });
    tables.set('users', { keys: ['id'], items: [{ id: { S: '1' }, name: { S: 'User 1' } }] });
    buckets.set(process.env.BUCKET_CSV_NAME || 'local-uploads', new Map());
    const queueNames = [process.env.SQS_NAME || 'local-jobs'];
    for (const value of [process.env.QUEUE_URL_1, process.env.QUEUE_URL_2]) {
      if (value) { try { queueNames.push(new URL(value).pathname.split('/').filter(Boolean).at(-1)); } catch {} }
    }
    for (const name of queueNames.filter(Boolean)) queues.set(name, []);
    secrets.set(process.env.SECRET_NAME || 'local-config', JSON.stringify({
      uploadCsvTableName: process.env.UPLOAD_CSV_TABLE_NAME || 'uploadCsvTableName',
      bucketCsvName: process.env.BUCKET_CSV_NAME || 'local-uploads',
      sqsName: process.env.SQS_NAME || 'local-jobs',
      prefixQueueURL: '/000000000000/',
    }, null, 2));
    functions.set('hello-local', demoSource);
  }
  seed();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    // Bind loopback and reject foreign hosts/origins; administrative writes require a custom header.
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(req.hostname)) return res.status(403).json({ message: 'Local access only.' });
    if (req.headers.origin && req.headers.origin !== `${req.protocol}://${req.headers.host}`) return res.status(403).json({ message: 'Cross-origin access is disabled.' });
    if (req.path.startsWith('/api/') && !['GET', 'HEAD'].includes(req.method) && req.headers['x-local-console'] !== '1') return res.status(403).json({ message: 'Missing local console header.' });
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'");
    next();
  });
  const origin = req => `${req.protocol}://${req.headers.host}`;
  const queueUrl = (req, name) => `${origin(req)}/000000000000/${encodeURIComponent(name)}`;
  const getQueue = input => {
    let name;
    try { name = decodeURIComponent(new URL(input.QueueUrl).pathname.split('/').filter(Boolean).at(-1)); } catch { fail('A valid QueueUrl is required.'); }
    if (!queues.has(name)) fail('Queue does not exist.', 'QueueDoesNotExist');
    return { name, messages: queues.get(name) };
  };
  const getTable = name => { if (!tables.has(name)) fail(`Table ${name} does not exist.`, 'ResourceNotFoundException'); return tables.get(name); };
  const getBucket = name => { if (!buckets.has(name)) fail('Bucket does not exist.', 'NoSuchBucket', 404); return buckets.get(name); };
  const getObject = (bucket, key) => { const object = getBucket(bucket).get(key); if (!object) fail('Object does not exist.', 'NoSuchKey', 404); return object; };
  function keyFor(table, item) {
    if (!item || table.keys.some(key => !item[key] || !['S', 'N', 'B'].some(type => typeof item[key][type] === 'string'))) fail(`Key requires: ${table.keys.join(', ')}`);
    return JSON.stringify(table.keys.map(key => item[key]));
  }
  function dynamo(action, input) {
    if (action === 'ListTables') return { TableNames: [...tables.keys()] };
    if (action === 'CreateTable') {
      const name = nameOf(input.TableName);
      if (tables.has(name)) fail('Table already exists.', 'ResourceInUseException');
      const schema = input.KeySchema || [{ AttributeName: 'id', KeyType: 'HASH' }];
      if (!Array.isArray(schema) || schema.length < 1 || schema.length > 2 || schema.filter(k => k.KeyType === 'HASH').length !== 1 || schema.some(k => !['HASH','RANGE'].includes(k.KeyType))) fail('Use one HASH key and an optional RANGE key.');
      const keys = schema.map(k => nameOf(k.AttributeName));
      if (new Set(keys).size !== keys.length) fail('Key names must be unique.');
      tables.set(name, { keys, items: [] });
      return { TableDescription: { TableName: name, TableStatus: 'ACTIVE' } };
    }
    const table = getTable(input.TableName);
    for (const option of ['ConditionExpression', 'ProjectionExpression', 'ExclusiveStartKey', 'IndexName', 'Limit']) {
      if (input[option] !== undefined) fail(`${option} is not supported by this local mock.`, 'UnsupportedOperation');
    }
    if (action === 'Scan') {
      let items = table.items;
      if (input.FilterExpression) {
        const match = /^(#[\w]+|[\w]+)\s*=\s*(:[\w]+)$/.exec(input.FilterExpression.trim());
        if (!match) fail('Only a single equality filter is supported.', 'UnsupportedOperation');
        const field = match[1].startsWith('#') ? input.ExpressionAttributeNames?.[match[1]] : match[1];
        const value = input.ExpressionAttributeValues?.[match[2]];
        if (!field || !value) fail('Missing expression attribute name or value.');
        items = items.filter(item => JSON.stringify(item[field]) === JSON.stringify(value));
      }
      return { Items: clone(items), Count: items.length, ScannedCount: table.items.length };
    }
    if (!['PutItem','GetItem','DeleteItem','UpdateItem'].includes(action)) fail(`Unsupported DynamoDB operation: ${action}`, 'UnsupportedOperation');
    const key = keyFor(table, action === 'PutItem' ? input.Item : input.Key);
    const index = table.items.findIndex(item => keyFor(table, item) === key);
    const old = index < 0 ? undefined : clone(table.items[index]);
    if (action === 'GetItem') return old ? { Item: old } : {};
    if (action === 'PutItem') {
      if (input.ReturnValues && !['NONE','ALL_OLD'].includes(input.ReturnValues)) fail('Unsupported ReturnValues.');
      if (index < 0) table.items.push(clone(input.Item)); else table.items[index] = clone(input.Item);
    }
    if (action === 'DeleteItem' && index >= 0) table.items.splice(index, 1);
    if (action === 'UpdateItem') {
      if (input.ReturnValues && !['NONE','ALL_OLD','ALL_NEW'].includes(input.ReturnValues)) fail('Unsupported ReturnValues.');
      const match = /^SET\s+(.+)$/i.exec(input.UpdateExpression || '');
      if (!match) fail('Only SET assignments are supported.', 'UnsupportedOperation');
      const updated = clone(old || input.Key);
      for (const assignment of match[1].split(',')) {
        const parts = /^\s*(#[\w]+|[\w]+)\s*=\s*(:[\w]+)\s*$/.exec(assignment);
        if (!parts) fail('Only SET field = :value assignments are supported.', 'UnsupportedOperation');
        const field = parts[1].startsWith('#') ? input.ExpressionAttributeNames?.[parts[1]] : parts[1];
        const value = input.ExpressionAttributeValues?.[parts[2]];
        if (!field || !value || table.keys.includes(field) || ['__proto__','constructor','prototype'].includes(field)) fail('Invalid update field or value.');
        updated[field] = clone(value);
      }
      if (index < 0) table.items.push(updated); else table.items[index] = updated;
      if (input.ReturnValues === 'ALL_NEW') return { Attributes: clone(updated) };
    }
    return input.ReturnValues === 'ALL_OLD' && old ? { Attributes: old } : {};
  }
  function sqs(action, input, req) {
    if (action === 'ListQueues') return { QueueUrls: [...queues.keys()].filter(n => n.startsWith(input.QueueNamePrefix || '')).map(n => queueUrl(req, n)) };
    if (action === 'CreateQueue') { const name = nameOf(input.QueueName); if (!queues.has(name)) queues.set(name, []); return { QueueUrl: queueUrl(req, name) }; }
    if (action === 'GetQueueUrl') { if (!queues.has(input.QueueName)) fail('Queue does not exist.', 'QueueDoesNotExist'); return { QueueUrl: queueUrl(req, input.QueueName) }; }
    const { messages } = getQueue(input);
    if (action === 'SendMessage') {
      if (typeof input.MessageBody !== 'string' || !input.MessageBody.length) fail('MessageBody must be a nonempty string.');
      if (input.MessageGroupId || input.MessageDeduplicationId || input.MessageAttributes || input.DelaySeconds) fail('FIFO, attributes and delay are not supported.', 'UnsupportedOperation');
      const message = { MessageId: crypto.randomUUID(), Body: input.MessageBody, MD5OfBody: md5(input.MessageBody), visibleAt: 0 };
      messages.push(message);
      return { MessageId: message.MessageId, MD5OfMessageBody: message.MD5OfBody };
    }
    if (action === 'ReceiveMessage') {
      const count = input.MaxNumberOfMessages ?? 1, timeout = input.VisibilityTimeout ?? 30;
      if (!Number.isInteger(count) || count < 1 || count > 10 || !Number.isInteger(timeout) || timeout < 0 || timeout > 43200) fail('Invalid message count or visibility timeout.');
      const selected = messages.filter(m => m.visibleAt <= Date.now()).slice(0, count);
      return { Messages: selected.map(m => { m.visibleAt = Date.now() + timeout * 1000; m.ReceiptHandle = crypto.randomUUID(); const { visibleAt, ...result } = m; return result; }) };
    }
    if (action === 'DeleteMessage') {
      const index = messages.findIndex(m => m.ReceiptHandle === input.ReceiptHandle && m.visibleAt > Date.now());
      if (index < 0) fail('Receive the message again to obtain a current receipt handle.', 'ReceiptHandleIsInvalid');
      messages.splice(index, 1); return {};
    }
    if (action === 'PurgeQueue') { messages.splice(0); return {}; }
    fail(`Unsupported SQS operation: ${action}`, 'UnsupportedOperation');
  }
  function secretAction(action, input) {
    if (action === 'ListSecrets') return { SecretList: [...secrets.keys()].map(Name => ({ Name })) };
    const name = input.Name || input.SecretId;
    if (action === 'CreateSecret' || action === 'PutSecretValue') {
      if (typeof name !== 'string' || !name || name.length > 512 || typeof input.SecretString !== 'string') fail('Name and SecretString are required.');
      if (action === 'CreateSecret' && secrets.has(name)) fail('Secret already exists.', 'ResourceExistsException');
      if (action === 'PutSecretValue' && !secrets.has(name)) fail('Secret not found.', 'ResourceNotFoundException');
      secrets.set(name, input.SecretString); return { Name: name };
    }
    if (action === 'GetSecretValue') { if (!secrets.has(name)) fail('Secret not found.', 'ResourceNotFoundException'); return { Name: name, SecretString: secrets.get(name) }; }
    fail(`Unsupported Secrets operation: ${action}`, 'UnsupportedOperation');
  }
  const jsonBody = express.json({ type: ['application/json', 'application/x-amz-json-1.0', 'application/x-amz-json-1.1'], limit: '1mb' });
  app.get('/health', (req, res) => res.json({ status: 'ok', storage: 'memory' }));
  app.get('/api/state', (req, res) => res.json({
    endpoint: origin(req), region: process.env.AWS_REGION || 'us-east-1',
    tables: [...tables].map(([name, t]) => ({ name, keys: t.keys, items: t.items })),
    buckets: [...buckets].map(([name, objects]) => ({ name, objects: [...objects].map(([key, o]) => ({ key, size: o.body.length, type: o.type, modified: o.modified })) })),
    queues: [...queues].map(([name, messages]) => ({ name, url: queueUrl(req, name), messages: messages.map(m => ({ ...m, visible: m.visibleAt <= Date.now() })) })),
    secrets: [...secrets.keys()], functions: [...functions].map(([name, source]) => ({ name, source })), activity,
  }));
  app.post('/api/reset', jsonBody, (req, res) => {
    if (activeInvocations) fail('Wait for running functions to finish before resetting.', 'Conflict', 409);
    seed(); activity = []; record('System', 'Reset', 'Seed fixtures restored'); res.json({ ok: true });
  });
  for (const [service, handler] of [['dynamodb', dynamo], ['sqs', sqs], ['secrets', secretAction]]) {
    app.post(`/api/${service}`, jsonBody, (req, res) => {
      const { action, input = {} } = req.body || {};
      const result = handler(action, input, req);
      record(service, action, input.TableName || input.QueueName || input.QueueUrl || input.Name || input.SecretId || '');
      res.json(result);
    });
  }
  app.post('/api/buckets', jsonBody, (req, res) => {
    const name = nameOf(req.body.name); if (buckets.has(name)) fail('Bucket already exists.'); buckets.set(name, new Map()); record('s3', 'CreateBucket', name); res.json({ name });
  });
  app.put('/api/objects/:bucket/*key', express.raw({ type: () => true, limit: '20mb' }), (req, res) => {
    const key = req.params.key.join('/'); const body = req.body || Buffer.alloc(0);
    getBucket(req.params.bucket).set(key, { body, type: req.headers['content-type'] || 'application/octet-stream', modified: new Date().toISOString() });
    record('s3', 'PutObject', `${req.params.bucket}/${key}`); res.json({ key, size: body.length });
  });
  app.get('/api/objects/:bucket/*key', (req, res) => {
    const key = req.params.key.join('/'); const object = getObject(req.params.bucket, key);
    res.attachment(path.basename(key)); res.type('application/octet-stream').send(object.body);
  });
  app.delete('/api/objects/:bucket/*key', (req, res) => {
    const key = req.params.key.join('/'); getBucket(req.params.bucket).delete(key); record('s3', 'DeleteObject', key); res.json({ ok: true });
  });
  app.post('/api/functions', jsonBody, (req, res) => {
    const name = nameOf(req.body.name); const source = req.body.source;
    if (typeof source !== 'string' || !source.trim() || source.length > 100000) fail('Source is required (maximum 100 KB).');
    new (require('node:vm').Script)(ModuleWrap(source));
    functions.set(name, source); record('lambda', 'SaveFunction', name); res.json({ name });
  });
  function ModuleWrap(source) { return `(function(exports,require,module,__filename,__dirname){\n${source}\n})`; }
  app.post('/api/functions/:name/invoke', jsonBody, async (req, res) => {
    const name = req.params.name;
    if (!functions.has(name)) fail('Function does not exist.', 'ResourceNotFoundException', 404);
    if (activeInvocations >= 4) fail('Up to four local invocations can run at once.', 'TooManyRequestsException', 429);
    activeInvocations++;
    const started = Date.now();
    try {
      const result = await new Promise((resolve, reject) => {
        const endpoint = origin(req);
        const child = fork(path.join(__dirname, 'lambda-worker.js'), [], {
          cwd: __dirname, silent: true, execArgv: [],
          env: { PATH: process.env.PATH, NODE_ENV: 'development', AWS_REGION: process.env.AWS_REGION || 'us-east-1', AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test', AWS_EC2_METADATA_DISABLED: 'true', AWS_ENDPOINT_URL: endpoint, DYNAMODB_ENDPOINT: endpoint, S3_ENDPOINT: endpoint, SQS_ENDPOINT: endpoint, SECRETS_ENDPOINT: endpoint, LOCAL_FUNCTION_NAME: name },
        });
        let logs = '', settled = false;
        const finish = (error, message) => { if (settled) return; settled = true; clearTimeout(timer); child.kill('SIGKILL'); error ? reject(error) : resolve({ ...message, logs, durationMs: Date.now() - started }); };
        const timer = setTimeout(() => finish(null, { error: 'Function timed out after 10 seconds.' }), 10000);
        for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { if (logs.length < 64000) logs += chunk.toString().slice(0, 64000 - logs.length); });
        child.on('message', message => finish(null, message));
        child.on('error', error => finish(error));
        child.on('exit', code => finish(null, { error: `Function exited before returning a result (code ${code}).` }));
        child.send({ source: functions.get(name), event: req.body?.event ?? {} });
      });
      record('lambda', 'Invoke', name, result.error ? 'error' : 'success'); res.json(result);
    } finally { activeInvocations--; }
  });
  app.post('/', jsonBody, (req, res) => {
    const target = req.headers['x-amz-target'] || '';
    const [prefix, action] = target.split('.');
    const handler = { DynamoDB_20120810: dynamo, AmazonSQS: sqs, secretsmanager: secretAction }[prefix];
    if (!handler) fail('Unsupported operation.', 'UnsupportedOperation');
    const result = handler(action, req.body || {}, req); record(prefix, action, 'SDK'); res.json(result);
  });
  app.use(express.static(path.join(__dirname, 'public')));
  // Path-style S3 subset for AWS SDK clients. The console uses the same in-memory objects.
  app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public/index.html')));
  app.all('/:bucket{/*key}', express.raw({ type: () => true, limit: '20mb' }), (req, res) => {
    const bucket = req.params.bucket, key = req.params.key?.join('/');
    if (bucket === 'api') fail('Unknown console endpoint.', 'NotFound', 404);
    const sendXml = body => res.type('application/xml').send(body);
    if (req.method === 'PUT' && !key) { if (!buckets.has(bucket)) buckets.set(bucket, new Map()); record('s3','CreateBucket',bucket); return res.sendStatus(200); }
    if (req.method === 'GET' && !key) {
      const objects = [...getBucket(bucket)].filter(([k]) => k.startsWith(req.query.prefix || ''));
      return sendXml(`<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${xml(bucket)}</Name><IsTruncated>false</IsTruncated><KeyCount>${objects.length}</KeyCount>${objects.map(([k,o]) => `<Contents><Key>${xml(k)}</Key><Size>${o.body.length}</Size><LastModified>${o.modified}</LastModified><ETag>"${md5(o.body)}"</ETag></Contents>`).join('')}</ListBucketResult>`);
    }
    if (req.method === 'PUT' && key) {
      if (req.headers['content-encoding']?.includes('aws-chunked')) fail('Streaming aws-chunked uploads are not supported.', 'NotImplemented', 501);
      const body = req.body || Buffer.alloc(0); getBucket(bucket).set(key, { body, type: req.headers['content-type'] || 'application/octet-stream', modified: new Date().toISOString() }); record('s3','PutObject',`${bucket}/${key}`); return res.set('ETag', `"${md5(body)}"`).status(200).end();
    }
    if (['GET','HEAD'].includes(req.method) && key) { const o = getObject(bucket,key); return res.set({ 'Content-Type': o.type, 'Content-Length': String(o.body.length), ETag: `"${md5(o.body)}"` }).send(o.body); }
    if (req.method === 'DELETE' && key) { getBucket(bucket).delete(key); record('s3','DeleteObject',`${bucket}/${key}`); return res.status(204).end(); }
    fail('Unsupported S3 operation.', 'NotImplemented', 501);
  });
  app.use((error, req, res, next) => {
    record('System', req.method, req.path, 'error');
    const status = error.status || 400;
    const name = error.type === 'entity.parse.failed' ? 'ValidationException' : error.name || 'Error';
    if (!req.path.startsWith('/api/') && req.method !== 'POST') return res.status(status).type('application/xml').send(`<Error><Code>${xml(name)}</Code><Message>${xml(error.message)}</Message></Error>`);
    res.status(status).json({ __type: name, message: error.message });
  });
  return app;
}
module.exports = { createApp };
