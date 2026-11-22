const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {WebSocket}=require('ws');const docker=require('../lib/docker');const {createApp}=require('../server');const {openStore}=require('../lib/store');
test('Ubuntu terminal provides a real PTY, persistent shell state, resize and rejects foreign origins',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lab-terminal-'));let app,server,closeTerminal,ws;
  const container=docker.id('terminal-test');
  try{
    await docker.ensureImage('ubuntu:24.04');
    await docker.command(['run','-d','--name',container,'--label',`${docker.LABEL}=true`,...docker.limits(128),'ubuntu:24.04','sleep','3600']);
    app=createApp({dataDir:dir});app.locals.close();
    const store=openStore(dir);const state=store.load();state.extra.instances.set('ubuntu-test',{name:'ubuntu-test',container,image:'ubuntu:24.04',memory:128});store.save(state);store.close();
    app=createApp({dataDir:dir});server=app.listen(0,'127.0.0.1');closeTerminal=app.locals.attachTerminal(server);await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}`;
    const ticket=()=>fetch(base+'/api/ec2/terminal',{method:'POST',headers:{'content-type':'application/json','x-local-console':'1'},body:'{"name":"ubuntu-test"}'}).then(r=>r.json());
    const denied=await ticket();await new Promise((resolve,reject)=>{const bad=new WebSocket(base.replace('http:','ws:')+'/terminal?token='+denied.token,{origin:'https://evil.example'});bad.on('unexpected-response',(req,res)=>{assert.equal(res.statusCode,403);res.resume();resolve();});bad.on('open',()=>reject(new Error('Foreign origin accepted')));bad.on('error',()=>{});});
    const {token}=await ticket();ws=new WebSocket(base.replace('http:','ws:')+'/terminal?token='+token,{origin:base});let output='';
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('No terminal readiness')),10000);ws.on('message',bytes=>{const m=JSON.parse(bytes);if(m.type==='error')reject(new Error(m.data));if(m.type==='output')output+=Buffer.from(m.data,'base64').toString();if(m.type==='ready'){clearTimeout(timer);resolve();}});ws.on('error',reject);});
    ws.send(JSON.stringify({type:'resize',cols:100,rows:28}));
    ws.send(JSON.stringify({type:'input',data:'cd /tmp\nexport LAB_VALUE=works\nprintf "RESULT:%s:%s\\n" "$PWD" "$LAB_VALUE"\ntest -t 0 && echo REAL_TTY\ncat /etc/os-release\n'}));
    await new Promise((resolve,reject)=>{const start=Date.now();const timer=setInterval(()=>{if(output.includes('RESULT:/tmp:works')&&output.includes('Ubuntu')&&/[\r\n]REAL_TTY[\r\n]/.test(output)){clearInterval(timer);resolve();}else if(Date.now()-start>10000){clearInterval(timer);reject(new Error(output));}},50);});
    ws.send(JSON.stringify({type:'input',data:'exit\n'}));await new Promise(r=>ws.once('close',r));
  }finally{ws?.terminate();closeTerminal?.();if(server)await new Promise(r=>server.close(r));app?.locals.close();await docker.command(['rm','-f',container]).catch(()=>{});fs.rmSync(dir,{recursive:true,force:true});}
});
