const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createApp}=require('../server');
const docker=require('../lib/docker');
const runtime=require('../lib/runtimes');
const {openStore}=require('../lib/store');
process.env.REGISTRY_PORT='15001';
let app,server,url,workspace;const directory=fs.mkdtempSync(path.join(os.tmpdir(),'aws-lab-docker-'));
async function start(){app=createApp({dataDir:directory});server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));url=`http://127.0.0.1:${server.address().port}`;}
async function stop(){await new Promise(r=>server.close(r));app.locals.close();}
before(async()=>{assert.equal((await docker.available()).available,true,'Start Docker before npm run test:docker');await start();const db=openStore(directory);workspace=db.load().extra.workspaceId;db.close();});
after(async()=>{await stop();const containers=await docker.command(['ps','-aq','--filter',`label=${docker.LABEL}.workspace=${workspace}`]);for(const id of containers.stdout.trim().split('\n').filter(Boolean)){const info=await docker.inspect(id);const volumes=info.Mounts.filter(m=>m.Type==='volume').map(m=>m.Name);await docker.command(['rm','-f',id]);for(const volume of volumes)await docker.command(['volume','rm',volume]);}await docker.command(['image','rm','aws-lab-test-commit:latest']).catch(()=>{});fs.rmSync(directory,{recursive:true,force:true});});
async function post(p,body,status=200){const r=await fetch(url+p,{method:'POST',headers:{'content-type':'application/json','x-local-console':'1'},body:JSON.stringify(body)});const value=await r.json();assert.equal(r.status,status,JSON.stringify(value));return value;}
test('Java, C# and Go execute real compiled handlers with source layers',async()=>{
  for(const name of ['java','dotnet','go']){
    await post('/api/functions',{name:'test-'+name,source:runtime.definitions[name].source,config:{runtime:name,memory:512,timeout:120}});
    const result=await post('/api/functions/test-'+name+'/invoke',{event:{test:name}});assert.ok(!result.error,JSON.stringify(result));assert.deepEqual(name==='java'?result.result:result.result.input,{test:name});console.log(name,'completed',result.durationMs+'ms');
  }
});
test('EC2 enforces real cgroup limits and a total 1 GB budget, supports shell and commit',async(t)=>{
  const existing=await docker.list('ec2');
  for(const c of existing){if((await docker.inspect(c.ID)).State.Running){t.skip('EC2 budget is already allocated by another workspace; leave its containers untouched.');return;}}
  const first=await post('/api/ec2',{action:'create',name:'test-a',memory:512});
  const info=await docker.inspect(first.container);assert.equal(info.HostConfig.Memory,512*1024*1024);assert.equal(info.HostConfig.MemorySwap,512*1024*1024);
  await post('/api/ec2',{action:'create',name:'test-b',memory:512});
  await post('/api/ec2',{action:'create',name:'too-much',memory:128},400);
  const output=await post('/api/ec2',{action:'exec',name:'test-a',command:'echo persisted >/tmp/lesson; cat /tmp/lesson'});assert.match(output.stdout,/persisted/);
  await post('/api/ec2',{action:'commit',name:'test-a',image:'aws-lab-test-commit:latest'});
  await post('/api/ec2',{action:'stop',name:'test-a'});await post('/api/ec2',{action:'create',name:'test-c',memory:128});
  await post('/api/ec2',{action:'start',name:'test-a'},400);
  await post('/api/ec2',{action:'terminate',name:'test-c'});await post('/api/ec2',{action:'start',name:'test-a'});
  for(const name of ['test-a','test-b'])await post('/api/ec2',{action:'terminate',name});
});
test('ECR push/pull feeds an ECS service with real replica containers',async()=>{
  await post('/api/ecr',{action:'create',name:'test-repo'});
  const image=await post('/api/ecr',{action:'push',name:'test-repo',image:'alpine:3.21',tag:'v1'});
  await post('/api/ecr',{action:'pull',name:'test-repo',tag:'v1'});
  await post('/api/ecs',{action:'create',name:'test-cluster'});
  let service=await post('/api/ecs',{action:'service',name:'test-cluster',service:'worker',image:image.image,memory:128,replicas:2,command:['sh','-c','echo hello-ecs; sleep 300']});assert.equal(service.tasks.length,2);
  for(const t of service.tasks)assert.equal((await docker.inspect(t.container)).State.Running,true);
  service=await post('/api/ecs',{action:'scale',name:'test-cluster',service:'worker',replicas:1});assert.equal(service.tasks.length,1);
  assert.match((await post('/api/ecs',{action:'logs',name:'test-cluster',service:'worker'})).logs,/hello-ecs/);
  await post('/api/ecs',{action:'scale',name:'test-cluster',service:'worker',replicas:0});
});
test('RDS PostgreSQL retains SQL data across database and app restarts; metrics are sampled',async()=>{
  await post('/api/rds',{action:'create',name:'test-db',engine:'postgres'});
  let ready=false;for(let i=0;i<40;i++){try{await post('/api/rds',{action:'query',name:'test-db',sql:'SELECT 1;'});ready=true;break;}catch{await new Promise(r=>setTimeout(r,1000));}}assert.ok(ready);
  await post('/api/rds',{action:'query',name:'test-db',sql:"CREATE TABLE lesson(id int primary key, value text); INSERT INTO lesson VALUES(1, 'durable');"});
  await post('/api/rds',{action:'stop',name:'test-db'});await stop();await start();await post('/api/rds',{action:'start',name:'test-db'});
  let result;for(let i=0;i<20;i++){try{result=await post('/api/rds',{action:'query',name:'test-db',sql:'SELECT * FROM lesson;'});break;}catch{await new Promise(r=>setTimeout(r,1000));}}assert.match(result.stdout,/durable/);
  const tables=await post('/api/rds',{action:'tables',name:'test-db'});assert.ok(tables.tables.some(t=>t.name==='lesson'&&t.schema==='public'));
  const page=await post('/api/rds',{action:'browse',name:'test-db',schema:'public',table:'lesson',limit:1});assert.equal(page.total,1);assert.equal(page.rows[0].value,'durable');assert.equal(page.columns[0].name,'id');
  assert.equal((await post('/api/rds',{action:'browse',name:'test-db',schema:'public',table:'lesson',offset:1})).rows.length,0);
  await post('/api/rds',{action:'browse',name:'test-db',schema:'public',table:'lesson; DROP TABLE lesson'},400);
  await post('/api/rds',{action:'browse',name:'test-db',schema:'public',table:'lesson',limit:1000},400);
  await post('/api/cloudwatch',{action:'sample'});const infra=await fetch(url+'/api/infrastructure').then(r=>r.json());assert.ok(infra.metrics.some(m=>m.name==='MemoryMB'));
});

test('MySQL table browser lists schema, columns and paginated values without precision loss',async()=>{
  await post('/api/rds',{action:'create',name:'mysql-browser',engine:'mysql'});
  let ready=false;for(let i=0;i<60;i++){try{await post('/api/rds',{action:'query',name:'mysql-browser',sql:'SELECT 1;'});ready=true;break;}catch{await new Promise(r=>setTimeout(r,1000));}}assert.ok(ready,'MySQL startup');
  await post('/api/rds',{action:'query',name:'mysql-browser',sql:"CREATE TABLE lesson(id bigint primary key, title varchar(100), optional varchar(20)); INSERT INTO lesson VALUES(9007199254740993, 'hello', NULL), (9007199254740994, 'next', 'value');"});
  const tables=await post('/api/rds',{action:'tables',name:'mysql-browser'});assert.ok(tables.tables.some(t=>t.name==='lesson'&&t.schema==='lab'));
  const page=await post('/api/rds',{action:'browse',name:'mysql-browser',table:'lesson',schema:'lab',limit:1});assert.equal(page.total,2);assert.equal(page.rows[0].id,'9007199254740993');assert.equal(page.rows[0].optional,null);assert.equal(page.columns[1].name,'title');
  const next=await post('/api/rds',{action:'browse',name:'mysql-browser',table:'lesson',schema:'lab',limit:1,offset:1});assert.equal(next.rows[0].title,'next');
});

test('Fargate enforces CPU/memory and exposes live cluster/task/container state and failures',async()=>{
  await post('/api/ecs',{action:'create',name:'fargate-cluster'});
  await post('/api/ecs',{action:'service',name:'fargate-cluster',service:'invalid',launchType:'FARGATE',cpu:256,memory:128,image:'alpine:3.21'},400);
  let service=await post('/api/ecs',{action:'service',name:'fargate-cluster',service:'worker',launchType:'FARGATE',cpu:256,memory:512,image:'alpine:3.21',replicas:2,command:['sh','-c','echo stdout-message; echo stderr-message >&2; sleep 300']});
  const info=await docker.inspect(service.tasks[0].container);assert.equal(info.HostConfig.NanoCpus,250000000);assert.equal(info.HostConfig.Memory,512*1048576);assert.equal(info.Config.Labels['local.aws.lab.launchType'],'FARGATE');
  let state=await fetch(url+'/api/infrastructure').then(r=>r.json());let cluster=state.clusters.find(c=>c.name==='fargate-cluster');assert.equal(cluster.running,2);assert.equal(cluster.taskCount,2);assert.equal(cluster.services[0].deploymentStatus,'STABLE');
  const task=cluster.services[0].tasks[0];assert.equal(task.lastStatus,'RUNNING');assert.equal(task.image,'alpine:3.21');assert.equal(task.memoryMB,512);assert.ok(task.containerId);assert.ok(task.networks.length);
  const logs=await post('/api/ecs',{action:'logs',name:'fargate-cluster',service:'worker',task:task.taskId});assert.match(logs.logs,/stdout-message/);assert.match(logs.logs,/stderr-message/);
  await docker.command(['stop','-t','1',task.container]);state=await fetch(url+'/api/infrastructure').then(r=>r.json());cluster=state.clusters.find(c=>c.name==='fargate-cluster');assert.equal(cluster.running,1);assert.equal(cluster.services[0].deploymentStatus,'DEGRADED');assert.equal(cluster.services[0].tasks[0].lastStatus,'STOPPED');
  await post('/api/ecs',{action:'scale',name:'fargate-cluster',service:'worker',replicas:1});await stop();await start();state=await fetch(url+'/api/infrastructure').then(r=>r.json());assert.equal(state.clusters.find(c=>c.name==='fargate-cluster').services[0].launchType,'FARGATE');
  await post('/api/ecs',{action:'scale',name:'fargate-cluster',service:'worker',replicas:0});
  await post('/api/ecs',{action:'service',name:'fargate-cluster',service:'failed',launchType:'FARGATE',cpu:256,memory:512,image:'alpine:3.21',replicas:1,command:['sh','-c','echo failed >&2; exit 7']});
  await new Promise(r=>setTimeout(r,100));state=await fetch(url+'/api/infrastructure').then(r=>r.json());const failed=state.clusters.find(c=>c.name==='fargate-cluster').services.find(s=>s.name==='failed');assert.equal(failed.deploymentStatus,'DEGRADED');assert.equal(failed.tasks[0].exitCode,7);assert.ok(failed.events.length);
  await post('/api/ecs',{action:'scale',name:'fargate-cluster',service:'failed',replicas:0});
});

test('Fargate nginx serves HTTP and exposes its mapped container port',async()=>{
  await post('/api/ecs',{action:'create',name:'fargate-web'});
  const service=await post('/api/ecs',{action:'service',name:'fargate-web',service:'nginx',launchType:'FARGATE',cpu:256,memory:512,image:'nginx:alpine',port:80,replicas:1});
  let response;for(let i=0;i<30;i++){try{const state=await fetch(url+'/api/infrastructure').then(r=>r.json());const task=state.clusters.find(c=>c.name==='fargate-web').services[0].tasks[0];const binding=task.ports['80/tcp'][0];response=await fetch('http://127.0.0.1:'+binding.HostPort);if(response.ok)break;}catch{}await new Promise(r=>setTimeout(r,200));}
  assert.ok(response?.ok,'Nginx should serve HTTP');assert.match(await response.text(),/Welcome to nginx/);
  await post('/api/ecs',{action:'scale',name:'fargate-web',service:'nginx',replicas:0});
});
