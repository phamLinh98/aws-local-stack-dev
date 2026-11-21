const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server');
const d = require('@aws-sdk/client-dynamodb');
const s = require('@aws-sdk/client-s3');
const q = require('@aws-sdk/client-sqs');
const secrets = require('@aws-sdk/client-secrets-manager');
let server, endpoint, db, s3, sqs, secret;
before(async () => {
  server = createApp({persist:false}).listen(0,'127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  endpoint = `http://127.0.0.1:${server.address().port}`;
  const options = { endpoint, region:'us-east-1',credentials:{accessKeyId:'test',secretAccessKey:'test'},maxAttempts:1 };
  db = new d.DynamoDBClient(options); s3 = new s.S3Client({...options,forcePathStyle:true,requestChecksumCalculation:'WHEN_REQUIRED'}); sqs = new q.SQSClient(options); secret = new secrets.SecretsManagerClient(options);
});
after(async()=>{for(const c of [db,s3,sqs,secret])c.destroy();await new Promise(resolve=>server.close(resolve));});
async function post(path, body){const r=await fetch(endpoint+path,{method:'POST',headers:{'content-type':'application/json','x-local-console':'1'},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};}
test('console serves HTML and rejects cross-origin administrative writes',async()=>{
  const response=await fetch(endpoint);assert.equal(response.status,200);assert.match(await response.text(),/Local AWS Lab/);
  assert.equal((await fetch(endpoint+'/api/reset',{method:'POST'})).status,403);
  assert.equal((await fetch(endpoint+'/api/reset',{method:'POST',headers:{'origin':'https://example.com','x-local-console':'1'}})).status,403);
});
test('DynamoDB SDK replaces matching keys, filters aliases and upserts with SET',async()=>{
  await db.send(new d.CreateTableCommand({TableName:'test-items',KeySchema:[{AttributeName:'id',KeyType:'HASH'}]}));
  for(const value of ['before','after'])await db.send(new d.PutItemCommand({TableName:'test-items',Item:{id:{S:'a'},name:{S:value}}}));
  let scan=await db.send(new d.ScanCommand({TableName:'test-items'}));assert.equal(scan.Items.length,1);assert.equal(scan.Items[0].name.S,'after');
  scan=await db.send(new d.ScanCommand({TableName:'test-items',FilterExpression:'#name = :name',ExpressionAttributeNames:{'#name':'name'},ExpressionAttributeValues:{':name':{S:'before'}}}));assert.equal(scan.Items.length,0);
  const updated=await db.send(new d.UpdateItemCommand({TableName:'test-items',Key:{id:{S:'b'}},UpdateExpression:'SET #name = :name',ExpressionAttributeNames:{'#name':'name'},ExpressionAttributeValues:{':name':{S:'new'}},ReturnValues:'ALL_NEW'}));assert.equal(updated.Attributes.name.S,'new');
  await assert.rejects(db.send(new d.ScanCommand({TableName:'test-items',FilterExpression:'contains(#name, :name)'})),/single equality/);
  await db.send(new d.DeleteItemCommand({TableName:'test-items',Key:{id:{S:'a'}}}));assert.equal((await db.send(new d.GetItemCommand({TableName:'test-items',Key:{id:{S:'a'}}}))).Item,undefined);
});
test('S3 console and SDK share binary object storage',async()=>{
  assert.equal((await post('/api/buckets',{name:'test-bucket'})).status,200);
  const body=Buffer.from([0,1,128,255,10]);
  await s3.send(new s.PutObjectCommand({Bucket:'test-bucket',Key:'folder/a.bin',Body:body,ContentType:'application/octet-stream'}));
  assert.deepEqual(Buffer.from(await (await fetch(endpoint+'/api/objects/test-bucket/folder/a.bin')).arrayBuffer()),body);
  const upload=await fetch(endpoint+'/api/objects/test-bucket/test.csv',{method:'PUT',headers:{'x-local-console':'1','content-type':'text/csv'},body:'id,name\n1,test'});assert.equal(upload.status,200);
  const get=await s3.send(new s.GetObjectCommand({Bucket:'test-bucket',Key:'test.csv'}));assert.equal(await get.Body.transformToString(),'id,name\n1,test');
  const list=await s3.send(new s.ListObjectsV2Command({Bucket:'test-bucket'}));assert.equal(list.Contents.length,2);
  await s3.send(new s.DeleteObjectCommand({Bucket:'test-bucket',Key:'test.csv'}));
  await assert.rejects(s3.send(new s.GetObjectCommand({Bucket:'test-bucket',Key:'test.csv'})),/Object does not exist/);
});
test('SQS SDK uses unique IDs, visibility and receipt deletion',async()=>{
  const {QueueUrl}=await sqs.send(new q.CreateQueueCommand({QueueName:'test-queue'}));
  const first=await sqs.send(new q.SendMessageCommand({QueueUrl,MessageBody:'one'}));
  const second=await sqs.send(new q.SendMessageCommand({QueueUrl,MessageBody:'two'}));assert.notEqual(first.MessageId,second.MessageId);
  const received=await sqs.send(new q.ReceiveMessageCommand({QueueUrl,MaxNumberOfMessages:10}));assert.equal(received.Messages.length,2);
  assert.equal((await sqs.send(new q.ReceiveMessageCommand({QueueUrl}))).Messages?.length||0,0);
  await sqs.send(new q.DeleteMessageCommand({QueueUrl,ReceiptHandle:received.Messages[0].ReceiptHandle}));
  const state=await (await fetch(endpoint+'/api/state')).json();assert.equal(state.queues.find(q=>q.name==='test-queue').messages.length,1);
});
test('Secrets created in console are readable with SDK',async()=>{
  await post('/api/secrets',{action:'CreateSecret',input:{Name:'test-secret',SecretString:'{"local":true}'}});
  assert.equal((await secret.send(new secrets.GetSecretValueCommand({SecretId:'test-secret'}))).SecretString,'{"local":true}');
});
test('Lambda returns values and logs, can use local SDK, and reports errors',async()=>{
  let save=await post('/api/functions',{name:'test-function',source:`exports.handler=async(event)=>{console.log('hello local'); const {DynamoDBClient,ListTablesCommand}=require('@aws-sdk/client-dynamodb'); const client=new DynamoDBClient({}); const data=await client.send(new ListTablesCommand({})); client.destroy(); return {event,tables:data.TableNames};};`});assert.equal(save.status,200);
  const run=await post('/api/functions/test-function/invoke',{event:{id:42}});assert.equal(run.status,200);assert.deepEqual(run.body.result.event,{id:42});assert.ok(run.body.result.tables.includes('test-items'));assert.match(run.body.logs,/hello local/);
  await post('/api/functions',{name:'test-function',source:'exports.handler=async()=>{throw new Error("expected failure")};'});
  assert.match((await post('/api/functions/test-function/invoke',{})).body.error,/expected failure/);
  save=await post('/api/functions',{name:'broken',source:'exports.handler = {{{'});assert.equal(save.status,400);
});
test('Lambda timeout terminates infinite loops',async()=>{
  await post('/api/functions',{name:'timeout-function',source:'exports.handler=async()=>{while(true){}};'});
  const response=await post('/api/functions/timeout-function/invoke',{});assert.match(response.body.error,/timed out/);
});

test('SDK helpers default to local credentials and reject remote endpoints',()=>{
  const {clientConfig}=require('../local-config');
  assert.equal(clientConfig('DYNAMODB').credentials.accessKeyId,'test');
  const previous=process.env.TEST_ENDPOINT;
  try { process.env.TEST_ENDPOINT='https://dynamodb.us-east-1.amazonaws.com'; assert.throws(()=>clientConfig('TEST'),/loopback/); }
  finally { if(previous===undefined)delete process.env.TEST_ENDPOINT;else process.env.TEST_ENDPOINT=previous; }
});
