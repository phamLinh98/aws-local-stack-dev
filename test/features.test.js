const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createApp}=require('../server');
let app,server,url;const directory=fs.mkdtempSync(path.join(os.tmpdir(),'aws-lab-persistence-'));
async function start(){app=createApp({dataDir:directory});server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));url=`http://127.0.0.1:${server.address().port}`;}
async function stop(){await new Promise(r=>server.close(r));app.locals.close();}
before(start);after(async()=>{await stop();fs.rmSync(directory,{recursive:true,force:true});});
async function post(p,body){const r=await fetch(url+p,{method:'POST',headers:{'content-type':'application/json','x-local-console':'1'},body:JSON.stringify(body)});const value=await r.json();assert.equal(r.status,200,JSON.stringify(value));return value;}
async function upload(body){const r=await fetch(url+'/api/objects/version-test/data.txt',{method:'PUT',headers:{'x-local-console':'1'},body});assert.equal(r.status,200);}
const state=()=>fetch(url+'/api/state').then(r=>r.json());
test('SQLite retains binary objects, table items, secret versions and functions after restart',async()=>{
  await post('/api/buckets',{name:'version-test'});await post('/api/bucket-config',{name:'version-test',versioning:true});
  await upload('first');await upload('second');
  await post('/api/dynamodb',{action:'PutItem',input:{TableName:'users',Item:{id:{S:'persisted'},name:{S:'Saved'}}}});
  await post('/api/secrets',{action:'CreateSecret',input:{Name:'versioned-secret',SecretString:'old'}});
  await post('/api/secrets',{action:'PutSecretValue',input:{SecretId:'versioned-secret',SecretString:'new'}});
  await stop();await start();
  assert.equal(await (await fetch(url+'/api/objects/version-test/data.txt')).text(),'second');
  const versions=await fetch(url+'/api/buckets/version-test/versions').then(r=>r.json());assert.equal(versions.versions.length,2);
  assert.equal(await (await fetch(url+'/api/objects/version-test/data.txt?versionId='+versions.versions[1].versionId)).text(),'first');
  assert.ok((await state()).tables.find(t=>t.name==='users').items.some(i=>i.id.S==='persisted'));
  const history=await fetch(url+'/api/secrets/versioned-secret/versions').then(r=>r.json());assert.equal(history.versions.length,2);
  await post('/api/secret-restore',{name:'versioned-secret',id:history.versions[0].id});assert.equal((await post('/api/secrets',{action:'GetSecretValue',input:{SecretId:'versioned-secret'}})).SecretString,'old');
});
test('S3 versioned delete marker and lifecycle preserve noncurrent data until expiration',async()=>{
  assert.equal((await fetch(url+'/api/objects/version-test/data.txt',{method:'DELETE',headers:{'x-local-console':'1'}})).status,200);
  assert.equal((await fetch(url+'/api/objects/version-test/data.txt')).status,404);
  let history=await fetch(url+'/api/buckets/version-test/versions').then(r=>r.json());assert.equal(history.versions[0].deleteMarker,true);
  await upload('third');await post('/api/bucket-config',{name:'version-test',versioning:true,lifecycle:{prefix:'data',expirationDays:1,noncurrentDays:2}});
  await post('/api/lifecycle/run',{daysAhead:3});assert.equal((await fetch(url+'/api/objects/version-test/data.txt')).status,404);
});
test('DynamoDB backup restore, TTL and partition Query',async()=>{
  const backup=await post('/api/table-backup',{name:'users',action:'create'});
  await post('/api/dynamodb',{action:'DeleteItem',input:{TableName:'users',Key:{id:{S:'persisted'}}}});
  await post('/api/table-backup',{name:'users',action:'restore',id:backup.id});
  const query=await post('/api/dynamodb',{action:'Query',input:{TableName:'users',KeyConditionExpression:'id = :id',ExpressionAttributeValues:{':id':{S:'persisted'}}}});assert.equal(query.Count,1);
  await post('/api/table-config',{name:'users',ttlAttribute:'expires'});
  await post('/api/dynamodb',{action:'PutItem',input:{TableName:'users',Item:{id:{S:'expired'},expires:{N:'1'}}}});
  const scan=await post('/api/dynamodb',{action:'Scan',input:{TableName:'users'}});assert.ok(!scan.Items.some(i=>i.id.S==='expired'));
});
test('SQS redrives unacknowledged messages to a configured DLQ',async()=>{
  const main=await post('/api/sqs',{action:'CreateQueue',input:{QueueName:'main'}});await post('/api/sqs',{action:'CreateQueue',input:{QueueName:'dead'}});
  await post('/api/queue-config',{name:'main',dlq:'dead',maxReceiveCount:1,visibilityTimeout:0});
  await post('/api/sqs',{action:'SendMessage',input:{QueueUrl:main.QueueUrl,MessageBody:'retry'}});
  assert.equal((await post('/api/sqs',{action:'ReceiveMessage',input:{QueueUrl:main.QueueUrl}})).Messages.length,1);
  assert.equal((await post('/api/sqs',{action:'ReceiveMessage',input:{QueueUrl:main.QueueUrl}})).Messages.length,0);
  assert.equal((await state()).queues.find(q=>q.name==='dead').messages.length,1);
});
test('Node layer version is executed and reserved concurrency rejects extra invokes',async()=>{
  await post('/api/layers',{name:'shared',runtime:'node',files:{'shared.js':'exports.value=42;'}});
  await post('/api/functions',{name:'layer-test',source:'exports.handler=async()=>require("shared").value;',config:{runtime:'node',layers:[{name:'shared',version:1}]}});
  assert.equal((await post('/api/functions/layer-test/invoke',{})).result,42);
  await post('/api/functions',{name:'slow-test',source:'exports.handler=async()=>{await new Promise(r=>setTimeout(r,500));return true;};',config:{replicas:1}});
  const first=post('/api/functions/slow-test/invoke',{});await new Promise(r=>setTimeout(r,50));
  assert.equal((await fetch(url+'/api/functions/slow-test/invoke',{method:'POST',headers:{'content-type':'application/json','x-local-console':'1'},body:'{}'})).status,429);await first;
  await stop();await start();assert.equal((await post('/api/functions/layer-test/invoke',{})).result,42);
  const infra=await fetch(url+'/api/infrastructure').then(r=>r.json());assert.ok(infra.logGroups.some(g=>g.name==='/aws/lambda/layer-test'));
});
