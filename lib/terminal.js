const {WebSocketServer,WebSocket}=require('ws');
const Docker=require('dockerode');
const crypto=require('node:crypto');
const docker=require('./docker');
async function client(){
  let host=process.env.DOCKER_HOST;
  if(!host){const result=await docker.command(['context','inspect','--format','{{json .Endpoints.docker.Host}}']);host=JSON.parse(result.stdout);}
  if(host.startsWith('unix://'))return new Docker({socketPath:host.slice(7)});
  if(host.startsWith('npipe://'))return new Docker({socketPath:host.slice(8)});
  throw new Error('Terminal requires a local Docker Unix socket or Windows named pipe.');
}
function installTerminal(app,ctx){
  const tickets=new Map(),connections=new Set();
  app.post('/api/ec2/terminal',ctx.jsonBody,async(req,res)=>{
    const instance=ctx.extra.instances.get(req.body.name);if(!instance)throw new Error('Instance not found.');
    const info=await docker.inspect(instance.container);if(!info.State.Running)throw new Error('Start the instance before connecting.');
    if(connections.size>=8)throw new Error('Close another terminal before opening a new one.');
    for(const [key,ticket]of tickets)if(ticket.expires<Date.now())tickets.delete(key);
    const token=crypto.randomBytes(32).toString('hex');tickets.set(token,{container:instance.container,name:instance.name,host:req.headers.host,expires:Date.now()+30000});
    res.json({token});
  });
  app.locals.attachTerminal=server=>{
    const wss=new WebSocketServer({noServer:true,maxPayload:64000});
    server.on('upgrade',(req,socket,head)=>{
      const url=new URL(req.url,'http://localhost');const ticket=tickets.get(url.searchParams.get('token'));
      if(url.pathname!=='/terminal'||!ticket||ticket.expires<Date.now()||ticket.host!==req.headers.host||req.headers.origin!==`http://${req.headers.host}`||connections.size>=8){socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');socket.destroy();return;}
      tickets.delete(url.searchParams.get('token'));
      wss.handleUpgrade(req,socket,head,ws=>open(ws,ticket));
    });
    return ()=>{for(const ws of connections)ws.close();wss.close();};
  };
  async function open(ws,ticket){
    connections.add(ws);let stream,exec,timer;
    const send=value=>{if(ws.readyState===WebSocket.OPEN){if(ws.bufferedAmount>1024*1024){ws.close(1013,'Terminal output too fast');return;}ws.send(JSON.stringify(value));}};
    const cleanup=()=>{clearTimeout(timer);connections.delete(ws);if(stream&&!stream.destroyed){stream.write('\x03\x04');stream.end();const release=setTimeout(()=>stream.destroy(),500);release.unref();}};
    ws.on('close',cleanup);ws.on('error',cleanup);
    const resetTimer=()=>{clearTimeout(timer);timer=setTimeout(()=>ws.close(1000,'Terminal idle timeout'),15*60000);timer.unref();};
    ws.on('message',async bytes=>{try{resetTimer();const message=JSON.parse(bytes.toString());if(message.type==='input'&&typeof message.data==='string'&&stream)stream.write(message.data);if(message.type==='resize'&&exec&&Number.isInteger(message.cols)&&Number.isInteger(message.rows)&&message.cols>=20&&message.cols<=300&&message.rows>=5&&message.rows<=100)await exec.resize({w:message.cols,h:message.rows});}catch(e){send({type:'error',data:e.message});}});
    try{
      await docker.inspect(ticket.container);const engine=await client();
      exec=await engine.getContainer(ticket.container).exec({Cmd:['sh','-c','if command -v bash >/dev/null 2>&1; then exec bash --noprofile --norc -i; else exec sh -i; fi'],AttachStdin:true,AttachStdout:true,AttachStderr:true,Tty:true,Env:['TERM=xterm-256color','PS1=\\u@\\h:\\w\\$ ']});
      stream=await exec.start({hijack:true,stdin:true,Tty:true});
      if(ws.readyState!==WebSocket.OPEN){cleanup();return;}
      stream.on('data',data=>send({type:'output',data:data.toString('base64')}));
      stream.on('error',e=>{send({type:'error',data:e.message});ws.close();});stream.on('end',()=>ws.close());
      send({type:'ready'});resetTimer();ctx.record('ec2','ConnectTerminal',ticket.name);ctx.persist();
    }catch(e){send({type:'error',data:e.message});ws.close();}
  }
}
module.exports={installTerminal};
