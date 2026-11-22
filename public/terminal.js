let liveTerminal;
function ec2TerminalPanel(instance){return `<div class="server-console"><div class="server-console-bar"><span>Linux server console · ${escapeHtml(instance.name)}</span><button class="button small-button" data-terminal-connect="${escapeHtml(instance.name)}">${instance.status==='running'?'Connect terminal':'Start instance to connect'}</button></div><div class="terminal-mount" data-terminal-name="${escapeHtml(instance.name)}"><p>Ubuntu / Linux interactive shell<br>Connect to type commands directly on this instance.</p></div></div>`;}
function closeLiveTerminal(){if(!liveTerminal)return;liveTerminal.socket?.close();liveTerminal.observer?.disconnect();liveTerminal.term.dispose();liveTerminal=null;}
async function connectTerminal(name){
  closeLiveTerminal();
  const mount=[...document.querySelectorAll('.terminal-mount')].find(el=>el.dataset.terminalName===name);if(!mount)return;
  const {token}=await post('/api/ec2/terminal',{name});
  const term=new Terminal({cursorBlink:true,fontSize:14,fontFamily:'Menlo, Consolas, monospace',theme:{background:'#080b10',foreground:'#d3e5d9',cursor:'#8ce99a'},scrollback:3000,rows:22,cols:80});
  mount.replaceChildren();term.open(mount);term.writeln('Connecting to Linux instance…');
  const socket=new WebSocket(`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}/terminal?token=${encodeURIComponent(token)}`);
  const send=message=>{if(socket.readyState===WebSocket.OPEN)socket.send(JSON.stringify(message));};
  const fit=()=>{const width=mount.clientWidth-20;const cols=Math.max(20,Math.min(300,Math.floor(width/8.5)));term.resize(cols,22);send({type:'resize',cols,rows:22});};
  const observer=new ResizeObserver(fit);observer.observe(mount);
  liveTerminal={socket,term,observer};
  term.onData(data=>send({type:'input',data}));
  socket.onmessage=event=>{const message=JSON.parse(event.data);if(message.type==='output')term.write(Uint8Array.from(atob(message.data),c=>c.charCodeAt(0)));if(message.type==='error')term.writeln('\r\n'+message.data);if(message.type==='ready'){term.clear();fit();term.focus();}};
  socket.onclose=()=>term.writeln('\r\n[Disconnected. Reconnect to open a new shell.]');
  socket.onerror=()=>term.writeln('\r\n[Unable to connect to the terminal.]');
  fit();
}
document.addEventListener('click',event=>{const button=event.target.closest('[data-terminal-connect]');if(button&&!busy)task(()=>connectTerminal(button.dataset.terminalConnect));});
window.addEventListener('hashchange',closeLiveTerminal);
// Rendering replaces the terminal node; close its shell connection promptly.
new MutationObserver(()=>{if(liveTerminal&&!liveTerminal.term.element?.isConnected)closeLiveTerminal();}).observe(document.documentElement,{childList:true,subtree:true});
