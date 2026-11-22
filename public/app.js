const $ = selector => document.querySelector(selector);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pretty = value => JSON.stringify(value, null, 2);
const services = [
  { id:'ec2', title:'EC2', icon:'▣', description:'Launch memory-limited Linux instances and run commands.', unit:'instances' },
  { id:'ecs', title:'ECS', icon:'⬡', description:'Deploy Docker images as services and scale task replicas.', unit:'clusters' },
  { id:'ecr', title:'ECR', icon:'▥', description:'Tag, push and pull images using a persistent local registry.', unit:'repositories' },
  { id:'rds', title:'RDS', icon:'◉', description:'Run PostgreSQL or MySQL with durable volumes and a SQL editor.', unit:'databases' },
  { id:'cloudwatch', title:'CloudWatch', icon:'▥', description:'Inspect logs, metric samples and threshold alarms.', unit:'log groups' },
  { id: 'lambda', title: 'Lambda', icon: 'λ', color: '#bc742a', tint: '#fff3e2', description: 'Run your functions with custom events and inspect the logs.', unit: 'functions' },
  { id: 's3', title: 'S3 Storage', icon: '▱', color: '#42876c', tint: '#e9f6ef', description: 'Upload, browse and download files in local buckets.', unit: 'buckets' },
  { id: 'dynamodb', title: 'DynamoDB', icon: '▤', color: '#507fca', tint: '#edf3ff', description: 'Explore tables and create or update your test data.', unit: 'tables' },
  { id: 'sqs', title: 'SQS Queues', icon: '≋', color: '#a7549c', tint: '#f8ecf7', description: 'Send, receive and delete messages in your local queues.', unit: 'queues' },
  { id: 'secrets', title: 'Secrets Manager', icon: '⚿', color: '#b05e69', tint: '#fceef0', description: 'Manage mock configuration and development secrets.', unit: 'secrets' },
];
let state, view = location.hash.slice(1) || 'overview', selected = Object.create(null), results = Object.create(null), drafts = Object.create(null), toastTimer;
let busy = false;
const dataFor = id => state[{ lambda: 'functions', s3: 'buckets', dynamodb: 'tables', sqs: 'queues', secrets: 'secrets',ec2:'instances',ecs:'clusters',ecr:'repositories',rds:'databases',cloudwatch:'logGroups' }[id]];
const nameFor = item => typeof item === 'string' ? item : item.name;
const current = () => dataFor(view)?.find(item => nameFor(item) === selected[view]);
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'x-local-console': '1', ...(options.body instanceof Blob ? {} : { 'content-type': 'application/json' }), ...options.headers } });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || `Request failed (${response.status})`);
  return result;
}
const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body) });
function toast(message, error = false) {
  clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').className = error ? 'error' : ''; $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, error ? 8000 : 3500);
}
async function refresh() {
  const [base, infra] = await Promise.all([api('/api/state'),api('/api/infrastructure')]); infrastructure=infra;state={...base,...infra}; if(!runtimeSamples.node)runtimeSamples=await api('/api/runtimes'); $('#connection-status').textContent = 'Local server connected'; render();
}
async function task(fn) {
  if (busy) return;
  busy = true; document.querySelectorAll('button').forEach(b => b.disabled = true);
  try { await fn(); } catch (error) { toast(error.message, true); }
  finally { busy = false; document.querySelectorAll('button').forEach(b => b.disabled = false); }
}
function navigation() {
  const link = (id, title, icon) => `<a class="nav-link ${view === id ? 'active' : ''}" href="#${id}" ${view === id ? 'aria-current="page"' : ''}><span class="nav-icon" aria-hidden="true">${icon}</span>${title}</a>`;
  $('#navigation').innerHTML = link('overview', 'Overview', '◫') + '<div class="nav-divider"></div>' + services.map(s => link(s.id, s.title, s.icon)).join('') + '<div class="nav-divider"></div>' + link('connection', 'Connection', '⌁');
}
function heading(title, description, action = '') {
  return `<div class="page-heading"><div><p class="eyebrow">LOCAL DEVELOPMENT</p><h1>${escapeHtml(title)}</h1><p class="subtitle">${escapeHtml(description)}</p></div>${action}</div>`;
}
function activityTable(limit = 15) {
  return state.activity.length ? `<div class="table-wrap"><table><thead><tr><th>Operation</th><th>Resource</th><th>Status</th><th>Time</th></tr></thead><tbody>${state.activity.slice(0, limit).map(a => `<tr><td><strong>${escapeHtml(a.action)}</strong><div class="hint">${escapeHtml(a.service)}</div></td><td class="truncate">${escapeHtml(a.resource || '—')}</td><td><span class="status ${a.status === 'error' ? 'error' : ''}">${escapeHtml(a.status)}</span></td><td class="muted">${new Date(a.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">Your workspace is ready. Create a resource or run a function to see activity here.</div>';
}
function overview() {
  const resources = services.reduce((n,s) => n + dataFor(s.id).length,0);
  return heading('Your local cloud, ready to build.', 'Create, experiment and test AWS workflows from one workspace.', '<button class="button" data-action="reset">Reset workspace</button>') +
    `<div class="banner"><span class="banner-icon">⌘</span><div><h3>All local. All yours.</h3><p>Built-in actions use this local server. SQLite persistence · Docker workloads · No AWS account required.</p></div><a class="button" href="#connection">Connection details</a></div>` +
    `<div class="stats">${[['Services',10,'Mock APIs & Docker workloads','◫'],['Resources',resources,'Across your workspace','▤'],['Stored objects',state.buckets.reduce((n,b)=>n+b.objects.length,0),'Files in local buckets','▱'],['Queued messages',state.queues.reduce((n,q)=>n+q.messages.length,0),'Available and in flight','≋']].map(([label,value,note,icon]) => `<div class="stat"><div class="stat-top">${label}<span class="mini-icon">${icon}</span></div><strong>${value}</strong><small>${note}</small></div>`).join('')}</div>` +
    `<div class="section-heading"><h2>Explore services</h2><span>10 services available</span></div><div class="service-grid">${services.map(s => `<a href="#${s.id}" class="service-card"><div class="service-card-top"><span class="service-symbol service-${s.id}">${s.icon}</span><span class="badge">LOCAL</span></div><h3>${s.title}</h3><p>${s.description}</p><div class="service-card-bottom"><span>${dataFor(s.id).length} ${s.unit}</span><b>Open service</b></div></a>`).join('')}</div>` +
    `<div class="section-heading"><h2>Recent activity</h2><span>Last 100 operations retained</span></div><section class="panel">${activityTable(8)}</section>`;
}
function output(id = view) {
  if (!results[id]) return '';
  return `<section class="panel"><div class="panel-head"><h2>Operation result</h2><button class="button small-button subtle" data-action="clear-result">Clear</button></div><div class="panel-body"><pre class="output">${escapeHtml(pretty(results[id]))}</pre></div></section>`;
}
function lambdaPanel(item) { return lambdaDetails(item); }
const objectPath = (bucket, key) => `/api/objects/${encodeURIComponent(bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`;
const bytes = n => n < 1024 ? `${n} B` : n < 1024*1024 ? `${(n/1024).toFixed(1)} KB` : `${(n/1024/1024).toFixed(1)} MB`;
function s3BasePanel(item) {
  return `<section class="panel"><div class="panel-head"><h2 class="resource-title">${escapeHtml(item.name)}</h2><span class="badge">${item.objects.length} objects</span></div><div class="panel-body"><form id="upload-form" class="upload"><div><label for="upload-file">File · max 20 MB</label><input id="upload-file" name="file" type="file" required></div><div><label for="object-key">Object key (optional)</label><input id="object-key" name="key" placeholder="folder/example.csv"></div><button class="button primary" type="submit">Upload file</button></form></div>${item.objects.length ? `<div class="table-wrap"><table><thead><tr><th>Object key</th><th>Size</th><th>Actions</th></tr></thead><tbody>${item.objects.map((o,i) => `<tr><td>${escapeHtml(o.key)}<div class="hint">${escapeHtml(o.type)}</div></td><td>${bytes(o.size)}</td><td><div class="actions"><a class="button small-button" href="${escapeHtml(objectPath(item.name,o.key))}" download>Download</a><button class="button small-button danger" data-action="delete-object" data-index="${i}">Delete</button></div></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No objects yet. Upload a file to start testing.</div>'}</section>`;
}
function dynamoBasePanel(item) {
  return `<section class="panel"><div class="panel-head"><h2 class="resource-title">${escapeHtml(item.name)}</h2><span class="badge">${item.items.length} items · key: ${escapeHtml(item.keys.join(' + '))}</span></div>${dynamoGrid(item)}</section><section class="panel"><div class="panel-head"><h2>Put item</h2><span class="metric-note">Same key replaces the existing item</span></div><div class="panel-body"><form id="item-form"><label for="item-json">Item · DynamoDB attribute format</label><textarea id="item-json" name="item" rows="8" spellcheck="false">${escapeHtml(pretty(Object.fromEntries([...item.keys.map(k=>[k,{S:'new-id'}]),['name',{S:'New item'}]])))}</textarea><div class="form-actions"><button class="button primary">Save item</button></div></form></div></section>${output()}`;
}
function sqsBasePanel(item) {
  return `<section class="panel"><div class="panel-head"><h2 class="resource-title">${escapeHtml(item.name)}</h2><span class="badge">${item.messages.length} messages</span></div><div class="panel-body"><div class="inline-code">${escapeHtml(item.url)}</div><form id="message-form"><label for="message-body" class="section-heading">Message body</label><textarea id="message-body" name="body" required rows="4">{ "task": "process-csv", "fileId": "123" }</textarea><div class="form-actions"><button type="button" class="button" data-action="receive">Receive messages</button><button class="button primary" type="submit">Send message</button></div><p class="hint">Receive applies the configured visibility timeout. Refresh to check visibility. Delete uses the receipt handle from the latest receive.</p></form></div>${item.messages.length ? `<div class="table-wrap"><table><thead><tr><th>Message</th><th>State</th><th>Action</th></tr></thead><tbody>${item.messages.map((m,i) => `<tr><td><pre class="output">${escapeHtml(m.Body)}</pre><div class="hint">${escapeHtml(m.MessageId)}</div></td><td><span class="badge">${m.visible ? 'Available' : 'In flight'}</span></td><td>${!m.visible && m.ReceiptHandle ? `<button class="button small-button danger" data-action="delete-message" data-index="${i}">Delete</button>` : '<span class="hint">Receive first</span>'}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">This queue is empty. Send a message to test a consumer.</div>'}</section>${output()}`;
}
function secretsBasePanel(item) {
  return `<section class="panel"><div class="panel-head"><h2 class="resource-title">${escapeHtml(item)}</h2><button class="button" data-action="load-secret">Load value</button></div><div class="panel-body"><p class="notice">Use mock values here. Secrets are stored in the local SQLite database and accessible to local clients.</p><form id="secret-form"><label for="secret-value">Secret value · text or JSON</label><textarea id="secret-value" name="value" rows="10" placeholder="Load the existing value, or enter a replacement." required></textarea><div class="form-actions"><button class="button primary">Save value</button></div></form></div></section>`;
}
function s3Panel(item){return s3BasePanel(item)+s3Features(item);}
function dynamoPanel(item){return dynamoBasePanel(item)+dynamoFeatures(item);}
function sqsPanel(item){return sqsBasePanel(item)+queueFeatures(item);}
function secretsPanel(item){return secretsBasePanel(item)+secretFeatures(item);}
function servicePage() {
  if(infrastructureIds.includes(view))return infrastructurePage(view);
  const service = services.find(s=>s.id===view), items = dataFor(view);
  if (!items.some(i=>nameFor(i)===selected[view])) selected[view] = items.length ? nameFor(items[0]) : null;
  const item = current();
  const creators = { lambda: 'Create function', s3: 'Create bucket', dynamodb: 'Create table', sqs: 'Create queue', secrets: 'Create secret' };
  const panels = { lambda:lambdaPanel, s3:s3Panel, dynamodb:dynamoPanel, sqs:sqsPanel, secrets:secretsPanel };
  return heading(service.title, service.description, `<button class="button primary" data-action="create">＋ ${creators[view]}</button>`) + `<div class="resource-layout"><section class="panel"><div class="panel-head"><h2>Resources</h2><span class="badge">${items.length}</span></div><div class="resource-list">${items.map((i,index)=>`<button class="resource-item ${nameFor(i)===selected[view]?'active':''}" data-action="select" data-index="${index}">${escapeHtml(nameFor(i))}<small>${view==='lambda'?escapeHtml(i.config?.runtime||'node'):view==='s3'?`${i.objects.length} objects`:view==='dynamodb'?`${i.items.length} items`:view==='sqs'?`${i.messages.length} messages`:'Local secret'}</small></button>`).join('') || '<div class="empty">No resources</div>'}</div></section><div class="stack">${item ? panels[view](item) : '<section class="panel empty">Create a resource to get started.</section>'}</div></div>`;
}
function connection() {
  return heading('Connection', 'Use this local workspace from your application or AWS SDK.') + `<div class="connection-grid"><section class="panel"><div class="panel-head"><h2>Local endpoint</h2></div><div class="panel-body"><dl class="kv"><dt>Endpoint</dt><dd>${escapeHtml(state.endpoint)}</dd><dt>Region</dt><dd>${escapeHtml(state.region)}</dd><dt>Access key</dt><dd>test</dd><dt>Secret key</dt><dd>test</dd><dt>Storage</dt><dd>SQLite + Docker volumes</dd></dl></div></section><section class="panel"><div class="panel-head"><h2>Supported scope</h2></div><div class="panel-body"><p class="subtitle">DynamoDB: item CRUD, simple equality Scan and SET updates. S3: path-style object CRUD and list. SQS: standard queue send, receive and delete. Secrets: string values. Lambda: local async CommonJS handler.</p><p class="hint">No IAM, event triggers, FIFO or full AWS runtime emulation. New infrastructure services use local console APIs. Presigned URLs do not validate signatures. Restarting preserves workspace data. Reset explicitly removes mock data.</p></div></section><section class="panel"><div class="panel-head"><h2>AWS SDK for JavaScript</h2></div><div class="panel-body"><pre class="output dark">${escapeHtml(`const { S3Client } = require('@aws-sdk/client-s3');

const s3 = new S3Client({
  endpoint: '${state.endpoint}',
  region: '${state.region}',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  forcePathStyle: true,
  requestChecksumCalculation: 'WHEN_REQUIRED',
});

// DynamoDBClient, SQSClient and SecretsManagerClient:
// use the same endpoint, region and test credentials.
// In local Lambda code, process.env.AWS_ENDPOINT_URL is provided.`)}</pre></div></section></div>`;
}
function render() {
  if (!['overview','connection',...services.map(s=>s.id)].includes(view)) view='overview';
  navigation(); $('#breadcrumb-current').textContent = services.find(s=>s.id===view)?.title || (view==='overview'?'Overview':'Connection');
  $('#content').innerHTML = view==='overview' ? overview() : view==='connection' ? connection() : servicePage();
}
window.addEventListener('hashchange', () => { view=location.hash.slice(1)||'overview'; if(state)render(); });
$('#refresh').addEventListener('click',()=>task(refresh));
$('#close-dialog').onclick = $('#cancel-dialog').onclick = () => $('#resource-dialog').close();
document.addEventListener('input', e => { if(view==='lambda' && current() && ['lambda-source','lambda-event'].includes(e.target.id)) drafts[current().name][e.target.id==='lambda-source'?'source':'event']=e.target.value; });
$('#content').addEventListener('click', event => {
  const button = event.target.closest('[data-action]'); if(!button || busy)return;
  const action = button.dataset.action, index = Number(button.dataset.index), item=current();
  if(action==='create'){ $('#dialog-title').textContent={lambda:'Create function',s3:'Create bucket',dynamodb:'Create table',sqs:'Create queue',secrets:'Create secret'}[view]; $('#resource-form').reset(); $('#resource-options').innerHTML=view==='lambda'?selectField('Runtime','runtime',[['node','Node.js'],['java','Java 21'],['dotnet','C# / .NET 8'],['go','Go 1.24']],'node'):''; $('#resource-dialog').showModal(); $('#resource-name').focus(); return; }
  if(action==='select'){selected[view]=nameFor(dataFor(view)[index]);results[view]=null;render();return;}
  if(action==='edit-item'){ $('#item-json').value=pretty(item.items[index]);$('#item-json').focus();return; }
  if(action==='clear-result'){results[view]=null;render();return;}
  task(async()=>{
    if(action==='reset'){if(!confirm('Reset all local data, uploaded files and function code to the starter fixtures?'))return;await post('/api/reset',{});drafts=Object.create(null);results=Object.create(null);selected=Object.create(null);await refresh();toast('Workspace reset.');return;}
    if(action==='delete-object'){const object=item.objects[index];if(!confirm(`Delete ${object.key}?`))return;await api(objectPath(item.name,object.key),{method:'DELETE'});}
    if(action==='delete-item'){if(!confirm('Delete this item?'))return;results.dynamodb=await post('/api/dynamodb',{action:'DeleteItem',input:{TableName:item.name,Key:Object.fromEntries(item.keys.map(k=>[k,item.items[index][k]]))}});}
    if(action==='receive')results.sqs=await post('/api/sqs',{action:'ReceiveMessage',input:{QueueUrl:item.url,MaxNumberOfMessages:10}});
    if(action==='delete-message')results.sqs=await post('/api/sqs',{action:'DeleteMessage',input:{QueueUrl:item.url,ReceiptHandle:item.messages[index].ReceiptHandle}});
    if(action==='load-secret'){const result=await post('/api/secrets',{action:'GetSecretValue',input:{SecretId:item}});$('#secret-value').value=result.SecretString;toast('Secret loaded.');return;}
    await refresh();toast('Operation completed.');
  });
});
$('#resource-form').addEventListener('submit', event => {
  event.preventDefault(); const formData=new FormData(event.target),name=formData.get('name'),runtime=formData.get('runtime')||'node';
  task(async()=>{
    if(view==='lambda')await post('/api/functions',{name,source:runtimeSamples[runtime].source,config:{runtime,timeout:runtime==='node'?10:60}});
    if(view==='s3')await post('/api/buckets',{name});
    if(view==='dynamodb')await post('/api/dynamodb',{action:'CreateTable',input:{TableName:name,KeySchema:[{AttributeName:'id',KeyType:'HASH'}]}});
    if(view==='sqs')await post('/api/sqs',{action:'CreateQueue',input:{QueueName:name}});
    if(view==='secrets')await post('/api/secrets',{action:'CreateSecret',input:{Name:name,SecretString:'{}'}});
    selected[view]=name;$('#resource-dialog').close();await refresh();toast('Resource created.');
  });
});
$('#content').addEventListener('submit', event => {
  if(event.target.dataset.extForm){handleExtendedSubmit(event);return;}
  event.preventDefault(); const form=event.target, data=new FormData(form), item=current(), intent=event.submitter?.value;
  task(async()=>{
    if(form.id==='lambda-form'){
      const parsedEvent=intent==='run'?JSON.parse(data.get('event')):null;
      await post('/api/functions',{name:item.name,source:data.get('source'),config:readLambdaConfig()});
      if(intent==='run'){toast('Running local function…');results.lambda=await post(`/api/functions/${encodeURIComponent(item.name)}/invoke`,{event:parsedEvent});}
    }
    if(form.id==='upload-form'){
      const file=data.get('file');if(file.size>20*1024*1024)throw new Error('Files must be 20 MB or smaller.');
      const key=data.get('key').trim()||file.name;if(!key||key.split('/').some(p=>!p||p==='.'||p==='..'))throw new Error('Use an object key without empty, dot or parent path segments.');
      await api(objectPath(item.name,key),{method:'PUT',body:file,headers:{'content-type':file.type||'application/octet-stream'}});
    }
    if(form.id==='item-form')results.dynamodb=await post('/api/dynamodb',{action:'PutItem',input:{TableName:item.name,Item:JSON.parse(data.get('item'))}});
    if(form.id==='message-form')results.sqs=await post('/api/sqs',{action:'SendMessage',input:{QueueUrl:item.url,MessageBody:data.get('body')}});
    if(form.id==='secret-form')await post('/api/secrets',{action:'PutSecretValue',input:{SecretId:item,SecretString:data.get('value')}});
    await refresh();toast(form.id==='lambda-form'&&intent==='run'?(results.lambda.error?'Function returned an error.':'Function completed.'):'Saved.',!!(form.id==='lambda-form'&&intent==='run'&&results.lambda.error));
  });
});
refresh().catch(error=>{ $('#connection-status').textContent='Server unavailable';$('#content').textContent='Cannot reach the local server. Start it with npm start, then refresh.';toast(error.message,true); });
