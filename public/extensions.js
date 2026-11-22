let infrastructure = { docker: {available:false}, instances:[], clusters:[], repositories:[], databases:[], logGroups:[], metrics:[], alarms:[] };
let runtimeSamples = {};
const infrastructureIds = ['ec2','ecs','ecr','cloudwatch','rds'];
const field = (label,name,value='',type='text') => `<div><label>${escapeHtml(label)}<input name="${name}" type="${type}" value="${escapeHtml(value)}" ${type==='number'?'min="0"':''}></label></div>`;
const selectField = (label,name,options,value) => `<div><label>${escapeHtml(label)}<select name="${name}">${options.map(([v,l])=>`<option value="${escapeHtml(v)}" ${String(v)===String(value)?'selected':''}>${escapeHtml(l)}</option>`).join('')}</select></label></div>`;
const memoryField = value => selectField('Memory limit','memory',[[128,'128 MB'],[512,'512 MB'],[1024,'1 GB']],value||128);
const actionButton = (label,action,name,extra='')=>`<button class="button small-button" data-ext="${action}" data-name="${escapeHtml(name)}" ${extra}>${label}</button>`;
const formPanel = (title,id,content,button='Save') => `<section class="panel"><div class="panel-head"><h2>${title}</h2></div><form class="panel-body" data-ext-form="${id}"><div class="settings-grid">${content}</div><div class="form-actions"><button class="button primary">${button}</button></div></form></section>`;
function infrastructurePage(id) {
  const service=services.find(s=>s.id===id);
  const dockerNotice = `<div class="notice ${infrastructure.docker.available?'ready-notice':''}">${infrastructure.docker.available?'Docker connected · '+escapeHtml(infrastructure.docker.version):'Docker is offline. Start Docker Desktop (Linux containers) or Colima, then Refresh.'} · Resources are stored persistently. Only containers created by this workspace can be controlled.</div>`;
  let html=heading(service.title,service.description)+dockerNotice;
  if(id==='ec2') {
    html+=`<div class="notice">EC2 learning model: Linux containers, not virtual machines. Total running EC2 limits ≤ 1 GB, excluding Docker engine, databases and other services. Stopping keeps the writable disk; terminating removes it.</div>`;
    html+=formPanel('Launch instance','ec2-create',field('Instance name','name','my-instance')+field('Image','image','ubuntu:24.04')+memoryField(128),'Launch instance');
    html+=resourceCards(infrastructure.instances,v=>`<h2>${escapeHtml(v.name)}</h2><p class="subtitle">${escapeHtml(v.image)} · ${v.memory} MB · <strong>${escapeHtml(v.status)}</strong></p><div class="form-actions">${actionButton('Start','ec2-start',v.name)}${actionButton('Stop','ec2-stop',v.name)}${actionButton('Terminate','ec2-terminate',v.name)}</div>${ec2TerminalPanel(v)}<form data-ext-form="ec2-commit" class="compact-form"><input type="hidden" name="name" value="${escapeHtml(v.name)}"><label>Image tag for commit<input name="image" value="lab-${escapeHtml(v.name)}:latest"></label><button class="button">Commit image</button></form>`);
  }
  if(id==='ecr') {
    html+=`<section class="panel panel-body"><h2>Local Docker registry</h2><p class="subtitle">${escapeHtml(infrastructure.registry?.endpoint||'localhost:5001')} · persistent registry volume · local push/pull</p><div class="form-actions">${actionButton('Start registry','ecr-registry','')}</div><p class="hint">Create a repository, tag an existing/local or public image, then push it. Use the resulting image URL in ECS. Private upstream registries require your own Docker login.</p></section>`;
    html+=formPanel('Create repository','ecr-create',field('Repository name','name','my-app'),'Create repository');
    html+=resourceCards(infrastructure.repositories,v=>`<h2>${escapeHtml(v.name)}</h2><form data-ext-form="ecr-push" class="compact-form"><input type="hidden" name="name" value="${escapeHtml(v.name)}">${field('Source Docker image','image','alpine:3.21')}${field('Tag','tag','latest')}<button class="button primary">Tag & push</button></form>${v.tags.map(t=>`<div class="version-row"><div><code>${escapeHtml(t.image)}</code><p class="hint">${bytes(t.size)} · ${escapeHtml(t.digest)}</p></div>${actionButton('Pull','ecr-pull',v.name,`data-tag="${escapeHtml(t.tag)}"`)}</div>`).join('')||'<p class="hint">No images pushed yet.</p>'}`);
  }
  if(id==='ecs') html+=ecsWorkspace();
  if(id==='rds') {
    html+=formPanel('Create database instance','rds-create',field('Database name','name','learning-db')+selectField('Engine','engine',[['postgres','PostgreSQL 16 · 128 MB'],['mysql','MySQL 8.4 · 512 MB']],'postgres'),'Create database');
    html+=resourceCards(infrastructure.databases,d=>`<h2>${escapeHtml(d.name)}</h2><p class="subtitle">${escapeHtml(d.engine)} · ${escapeHtml(d.status)} · ${d.memory} MB</p><p class="hint">${ports(d.ports)}<br>Persistent Docker volume: ${escapeHtml(d.volume)}. Initial startup may take a minute.</p><div class="form-actions">${actionButton('Start','rds-start',d.name)}${actionButton('Stop','rds-stop',d.name)}${actionButton('Connection credentials','rds-credentials',d.name)}</div>${rdsTableBrowser(d)}<form data-ext-form="rds-query"><input type="hidden" name="name" value="${escapeHtml(d.name)}"><label>SQL editor<textarea name="sql" rows="5" spellcheck="false">SELECT version();</textarea></label><button class="button primary">Run SQL</button></form>`);
  }
  if(id==='cloudwatch') {
    html+=`<section class="panel panel-body"><h2>Metrics & alarms</h2><p class="subtitle">Lambda invocations, errors and duration are recorded automatically. Sample Docker CPU/memory on demand.</p><div class="form-actions">${actionButton('Sample container metrics','cloudwatch-sample','')}</div></section>`;
    html+=formPanel('Create threshold alarm','cloudwatch-alarm',field('Alarm name','name','high-duration')+selectField('Metric','metric',[['Duration','Lambda duration (ms)'],['Errors','Lambda error (0/1)'],['Invocations','Invocation sample (1)'],['MemoryMB','Container memory (MB)'],['CPUPercent','Container CPU (%)']],'Duration')+field('Exact function/container name','resource','hello-local')+field('Threshold (≥)','threshold',1000,'number'),'Create alarm');
    html+=resourceCards(infrastructure.alarms,a=>`<h3>${escapeHtml(a.name)} <span class="badge">${escapeHtml(a.state)}</span></h3><p>${escapeHtml(a.metric)} ≥ ${a.threshold} · ${escapeHtml(a.resource)} · latest ${a.lastValue??'no data'}</p>`);
    html+=`<section class="panel"><div class="panel-head"><h2>Recent metric samples</h2><span class="hint">Latest sample thresholds; no AWS aggregation windows</span></div><div class="table-wrap"><table><thead><tr><th>Resource</th><th>Metric</th><th>Value</th><th>Time</th></tr></thead><tbody>${infrastructure.metrics.slice(-30).reverse().map(m=>`<tr><td>${escapeHtml(m.resource)}</td><td>${escapeHtml(m.name)}</td><td>${Number(m.value).toFixed(2)}</td><td>${new Date(m.timestamp).toLocaleTimeString()}</td></tr>`).join('')}</tbody></table></div></section>`;
    html+=resourceCards(infrastructure.logGroups,g=>`<h2>${escapeHtml(g.name)}</h2><pre class="output dark">${escapeHtml(g.events.slice(-25).map(e=>new Date(e.timestamp).toISOString()+' '+e.message).join('\n'))}</pre>`);
  }
  return `<div class="stack">${html}${output(id)}</div>`;
}
function resourceCards(items, body){return items.length?items.map(v=>`<section class="panel panel-body stack">${body(v)}</section>`).join(''):'<section class="panel empty">No resources yet. Create your first resource above.</section>';}
function ports(value){return Object.entries(value||{}).flatMap(([p,bindings])=>(bindings||[]).map(b=>`<span class="inline-code">127.0.0.1:${escapeHtml(b.HostPort)} → ${escapeHtml(p)}</span>`)).join(' ');}
function lambdaDetails(item){
  const config=item.config||{runtime:'node',memory:512,timeout:10,replicas:1,layers:[]};
  const draft=drafts[item.name]||{source:item.source,event:'{\n  "message": "Hello local"\n}',config:{...config}};drafts[item.name]=draft;draft.config||={...config};
  const c=draft.config,result=results.lambda;
  const layers=state.layers.filter(l=>l.runtime===c.runtime);
  return `<div class="notice">Node.js uses a local child process; Java, C# and Go compile/run inside Docker. Replicas = concurrent invocation slots (1–4), not warm provisioned environments. Only run trusted learning code.</div><section class="panel"><div class="panel-head"><h2>${escapeHtml(item.name)}</h2><span class="badge">${escapeHtml(c.runtime)}</span></div><div class="panel-body"><form id="lambda-config-form"><div class="settings-grid">${selectField('Runtime','runtime',[['node','Node.js'],['java','Java 21'],['dotnet','C# / .NET 8'],['go','Go 1.24']],c.runtime)}${memoryField(c.memory)}${field('Timeout seconds (1–120)','timeout',c.timeout,'number')}${field('Concurrent replicas (1–4)','replicas',c.replicas,'number')}<div><label>Layer versions (max 5)<select name="layers" multiple size="3">${layers.map(l=>`<option value="${escapeHtml(l.name)}:${l.version}" ${(c.layers||[]).some(r=>r.name===l.name&&r.version===l.version)?'selected':''}>${escapeHtml(l.name)}:${l.version}</option>`).join('')}</select></label></div></div></form><form id="lambda-form"><div class="editor-grid"><div><label for="lambda-source">Handler source</label><textarea class="code" id="lambda-source" name="source" spellcheck="false">${escapeHtml(draft.source)}</textarea><p class="hint">${c.runtime==='node'?'exports.handler(event); require("shared") loads shared.js from a layer. Memory setting limits V8 heap, not total process RSS.':c.runtime==='java'?'Handler.handle(String event) returns a JSON string. Layer .java files compile together.':c.runtime==='dotnet'?'Handler.Handle(JsonElement input) returns a JSON-serializable object. Layer .cs files compile together.':'Handle(json.RawMessage) (any, error). Layer .go files use package main.'}</p></div><div><label for="lambda-event">Test event · JSON</label><textarea id="lambda-event" name="event" rows="10" spellcheck="false">${escapeHtml(draft.event)}</textarea></div></div><div class="form-actions"><button type="button" class="button" data-ext="runtime-prepare" data-name="${escapeHtml(c.runtime)}">Prepare runtime image</button><button class="button" type="submit" name="intent" value="save">Save function</button><button class="button primary" type="submit" name="intent" value="run">Run test</button></div></form></div></section><section class="panel"><div class="panel-head"><h2>Execution output</h2><span class="hint">${result?`${result.durationMs} ms · ${result.error?'Failed':'Completed'}`:'Ready'}</span></div><div class="panel-body stack"><pre class="output">${escapeHtml(result?(result.error||pretty(result.result)):'Run a test to see its result.')}</pre><label>Logs<pre class="output dark">${escapeHtml(result?.logs||'No logs yet.')}</pre></label></div></section>${formPanel('Publish source layer','layer-publish',field('Layer name','name','shared')+selectField('Runtime','runtime',[['node','Node.js'],['java','Java'],['dotnet','C#'],['go','Go']],c.runtime)+`<div class="full-width"><label>Files · JSON object of relative path → source text<textarea name="files" rows="5">${escapeHtml(pretty(c.runtime==='node'?{'shared.js':'exports.message = "Hello from a layer";'}:c.runtime==='java'?{'Shared.java':'public class Shared { public static String message() { return "Hello from layer"; } }'}:c.runtime==='dotnet'?{'Shared.cs':'public static class Shared { public static string Message() => "Hello from layer"; }'}:{'shared.go':'package main\nfunc Message() string { return "Hello from layer" }'}))}</textarea></label></div>`,'Publish new version')}`;
}
function s3Features(item){const c=state.bucketConfig[item.name]||{},rule=c.lifecycle||{};return formPanel('Versioning & lifecycle','bucket-config',`<input type="hidden" name="name" value="${escapeHtml(item.name)}">`+selectField('Versioning','versioning',[['true','Enabled'],['false','Suspended / off']],String(!!c.versioning))+field('Lifecycle key prefix','prefix',rule.prefix||'')+field('Expire current object after days (0 = off)','expirationDays',rule.expirationDays||0,'number')+field('Expire noncurrent versions after days (0 = off)','noncurrentDays',rule.noncurrentDays||0,'number'))+`<section class="panel panel-body"><div class="form-actions">${actionButton('List object versions','s3-versions',item.name)}</div><form class="compact-form" data-ext-form="lifecycle-run">${field('Evaluate lifecycle days ahead (0 = now)','daysAhead',0,'number')}<button class="button">Run expiration rules</button></form><p class="hint">Rules also run every minute while the app is open. Evaluation affects all configured buckets and DynamoDB TTL. Versioned expiration creates a delete marker; noncurrent expiration removes old data.</p><div id="versions-output"></div></section>`;}
function dynamoFeatures(item){return formPanel('Time to live (TTL)','table-config',`<input type="hidden" name="name" value="${escapeHtml(item.name)}">`+field('TTL attribute (Number, Unix seconds; blank to disable)','ttlAttribute',item.ttlAttribute||''))+`<section class="panel panel-body"><h2>On-demand backups</h2><div class="form-actions">${actionButton('Create backup','table-backup',item.name)}</div>${state.tableBackups.filter(b=>b.name===item.name).map(b=>`<div class="version-row"><span>${escapeHtml(b.at)}</span>${actionButton('Restore','table-restore',item.name,`data-id="${b.id}"`)}</div>`).join('')}</section>`;}
function queueFeatures(item){const c=state.queueConfig[item.name]||{};return formPanel('Queue delivery & dead-letter policy','queue-config',`<input type="hidden" name="name" value="${escapeHtml(item.name)}">`+field('Default visibility timeout (seconds)','visibilityTimeout',c.visibilityTimeout??30,'number')+selectField('Dead-letter queue','dlq',[['','Disabled'],...state.queues.filter(q=>q.name!==item.name).map(q=>[q.name,q.name])],c.dlq||'')+field('Maximum receive count before redrive','maxReceiveCount',c.maxReceiveCount||3,'number'));}
function secretFeatures(item){return `<section class="panel panel-body"><h2>Secret versions</h2><p class="hint">Saving creates a new version. You can restore an earlier value.</p><div class="form-actions">${actionButton('List versions','secret-versions',item)}</div><div id="versions-output"></div></section>`;}
function readLambdaConfig(){const d=new FormData($('#lambda-config-form'));return {runtime:d.get('runtime'),memory:Number(d.get('memory')),timeout:Number(d.get('timeout')),replicas:Number(d.get('replicas')),layers:d.getAll('layers').map(ref=>{const [name,version]=ref.split(':');return {name,version:Number(version)};})};}
async function handleExtendedSubmit(event){event.preventDefault();const form=event.target,data=Object.fromEntries(new FormData(form)),id=form.dataset.extForm;task(async()=>{
  let result;
  const [service,action]=id.split('-');
  if(infrastructureIds.includes(service)){
    const payload={...data,action};for(const key of ['memory','replicas','port','threshold'])if(key in payload)payload[key]=Number(payload[key]);if(service==='ecs'&&payload.command)payload.command=JSON.parse(payload.command);if(service==='ecs'&&action==='service'){if(payload.launchType==='FARGATE'){const [cpu,memory]=payload.taskSize.split(':').map(Number);payload.cpu=cpu;payload.memory=memory;}delete payload.taskSize;}
    result=await post(`/api/${service}`,payload);
  }else if(id==='layer-publish')result=await post('/api/layers',{...data,files:JSON.parse(data.files)});
  else if(id==='bucket-config')result=await post('/api/bucket-config',{name:data.name,versioning:data.versioning==='true',lifecycle:{prefix:data.prefix,expirationDays:Number(data.expirationDays),noncurrentDays:Number(data.noncurrentDays)}});
  else if(id==='lifecycle-run'){if(!confirm('Apply expiration rules now? This may remove current objects and old versions.'))return;result=await post('/api/lifecycle/run',{daysAhead:Number(data.daysAhead)});}
  else if(id==='table-config')result=await post('/api/table-config',data);
  else if(id==='queue-config')result=await post('/api/queue-config',{...data,visibilityTimeout:Number(data.visibilityTimeout),maxReceiveCount:Number(data.maxReceiveCount)});
  results[view]=result;await refresh();if(id==='ec2-create')await connectTerminal(data.name);toast('Operation completed.');
});}
document.addEventListener('change',event=>{
  if(event.target.closest('#lambda-config-form')&&current()){
    const draft=drafts[current().name],oldRuntime=draft.config.runtime;draft.config=readLambdaConfig();
    if(draft.config.runtime!==oldRuntime){if(!confirm('Replace the editor with the sample for the selected runtime?')){draft.config.runtime=oldRuntime;render();return;}draft.source=runtimeSamples[draft.config.runtime].source;draft.config.layers=[];draft.config.timeout=draft.config.runtime==='node'?10:60;render();}
  }
});
document.addEventListener('click',event=>{
  const button=event.target.closest('[data-ext]');if(!button||busy)return;event.preventDefault();
  const action=button.dataset.ext,name=button.dataset.name;
  task(async()=>{
    let result;
    if(action.startsWith('rds-table')){await handleRdsBrowse(button);return;}
    if(action==='runtime-prepare'){if(name==='node'){toast('Node.js uses the current local runtime.');return;}toast('Preparing Docker runtime. The first download may take several minutes.');result=await post('/api/runtime/prepare',{runtime:name});}
    else if(action==='s3-versions'){
      const {versions}=await api(`/api/buckets/${encodeURIComponent(name)}/versions`);
      $('#versions-output').innerHTML=versions.map(v=>`<div class="version-row"><div><strong>${escapeHtml(v.key)}</strong><p class="hint">${escapeHtml(v.versionId)} · ${v.deleteMarker?'Delete marker':bytes(v.size)} · ${v.isLatest?'Latest':'Older'}</p></div>${!v.deleteMarker?`<a class="button small-button" download href="${objectPath(name,v.key)}?versionId=${encodeURIComponent(v.versionId)}">Download</a>`:''}</div>`).join('')||'<p class="hint">No versions yet.</p>';return;
    }else if(action==='secret-versions'){
      const {versions}=await api(`/api/secrets/${encodeURIComponent(name)}/versions`);$('#versions-output').innerHTML=versions.map(v=>`<div class="version-row"><span>${escapeHtml(v.at)}</span>${actionButton('Restore','secret-restore',name,`data-id="${v.id}"`)}</div>`).join('')||'<p class="hint">Save a value to create a version.</p>';return;
    }else if(action==='secret-restore'){if(!confirm('Restore this secret value?'))return;result=await post('/api/secret-restore',{name,id:button.dataset.id});}
    else if(action==='table-backup'||action==='table-restore'){if(action==='table-restore'&&!confirm('Replace the table with this backup?'))return;result=await post('/api/table-backup',{name,action:action==='table-backup'?'create':'restore',id:button.dataset.id});}
    else {
      const [service,operation]=action.split('-');if(operation==='terminate'&&!confirm(`Terminate ${name} and remove its container disk?`))return;
      result=await post(`/api/${service}`,{action:operation,name,tag:button.dataset.tag,service:button.dataset.service,task:button.dataset.task});
    }
    results[view]=result;await refresh();if(action==='ec2-start')await connectTerminal(name);toast('Operation completed.');
  });
});

const rdsBrowsers=Object.create(null);
function cellValue(value){if(value===null)return '<span class="null-value">NULL</span>';if(value===undefined)return '<span class="null-value">—</span>';return `<span class="data-cell">${escapeHtml(typeof value==='object'?JSON.stringify(value):String(value))}</span>`;}
function attributeValue(value){
  if(!value)return undefined;
  if('NULL'in value)return null;
  if('S'in value)return value.S;if('N'in value)return value.N;if('BOOL'in value)return value.BOOL;
  if('M'in value)return Object.fromEntries(Object.entries(value.M).map(([k,v])=>[k,attributeValue(v)]));
  if('L'in value)return value.L.map(attributeValue);
  return value.SS??value.NS??value.BS??value.B??value;
}
function dynamoGrid(item){
  if(!item.items.length)return '<div class="empty">No items yet. Add your first item below.</div>';
  const columns=[...new Set([...item.keys,...item.items.flatMap(row=>Object.keys(row))])];
  return `<div class="table-wrap"><table class="data-grid"><thead><tr>${columns.map(k=>`<th>${escapeHtml(k)}${item.keys.includes(k)?' <span class="badge">KEY</span>':''}</th>`).join('')}<th>Actions</th></tr></thead><tbody>${item.items.map((row,i)=>`<tr>${columns.map(k=>`<td>${cellValue(attributeValue(row[k]))}${row[k]?`<small class="cell-type">${escapeHtml(Object.keys(row[k])[0])}</small>`:''}</td>`).join('')}<td><div class="actions"><button class="button small-button" data-action="edit-item" data-index="${i}">Edit JSON</button><button class="button small-button danger" data-action="delete-item" data-index="${i}">Delete</button></div></td></tr>`).join('')}</tbody></table></div>`;
}
function rdsTableBrowser(database){
  const browser=rdsBrowsers[database.name];
  const button=(label,operation,index)=>actionButton(label,'rds-table-'+operation,database.name,index===undefined?'':`data-index="${index}"`);
  let body='';
  if(!browser)body='<p class="hint">Load the table list to explore schemas and rows.</p>';
  else if(!browser.tables.length)body='<div class="empty">No user tables. Create a table with SQL below, then reload the list.</div>';
  else {
    body=`<div class="rds-browser"><div class="rds-table-list">${browser.tables.map((t,i)=>button(`${t.schema}.${t.name}`,'select',i)).join('')}</div><div class="rds-table-detail">`;
    const page=browser.page;
    if(page){
      body+=`<h3>${escapeHtml(page.table.schema)}.${escapeHtml(page.table.name)}</h3><div class="form-actions">${button('Refresh rows','refresh')}<span class="hint">${page.total} rows · text display preserves numeric precision</span></div><details><summary>Columns & structure (${page.columns.length})</summary><div class="table-wrap"><table><thead><tr><th>Column</th><th>Type</th><th>Nullable</th><th>Default</th></tr></thead><tbody>${page.columns.map(c=>`<tr><td>${escapeHtml(c.name)}</td><td>${escapeHtml(c.type)}</td><td>${escapeHtml(c.nullable)}</td><td>${cellValue(c.defaultValue)}</td></tr>`).join('')}</tbody></table></div></details><div class="table-wrap"><table class="data-grid"><thead><tr>${page.columns.map(c=>`<th>${escapeHtml(c.name)}</th>`).join('')}</tr></thead><tbody>${page.rows.map(row=>`<tr>${page.columns.map(c=>`<td>${cellValue(row[c.name])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>${!page.rows.length?'<div class="empty">This table has no rows.</div>':''}<div class="form-actions">${page.offset>0?button('Previous','previous'):''}<span class="hint">${page.total?`${page.offset+1}–${Math.min(page.offset+page.rows.length,page.total)}`:'0'} of ${page.total}</span>${page.offset+page.rows.length<page.total?button('Next','next'):''}</div><p class="hint">50 rows per page. Data is read-only here; use the SQL editor to insert/update/delete. Refresh after SQL changes.</p>`;
    }else body+='<p class="hint">Select a table to view its data.</p>';
    body+='</div></div>';
  }
  return `<section class="nested-resource"><div class="panel-head"><h3>Tables & data</h3>${button('Load / reload tables','list')}</div>${body}</section>`;
}
async function handleRdsBrowse(button){
  const name=button.dataset.name,operation=button.dataset.ext.slice('rds-table-'.length);
  if(operation==='list'){
    const result=await post('/api/rds',{name,action:'tables'});rdsBrowsers[name]={tables:result.tables};
    if(result.tables.length){rdsBrowsers[name].page=await post('/api/rds',{name,action:'browse',table:result.tables[0].name,schema:result.tables[0].schema});}
  }else {
    const browser=rdsBrowsers[name],page=browser.page;
    const table=operation==='select'?browser.tables[Number(button.dataset.index)]:page.table;
    const offset=operation==='next'?page.offset+page.limit:operation==='previous'?Math.max(0,page.offset-page.limit):0;
    const result=await post('/api/rds',{name,action:'browse',table:table.name,schema:table.schema,offset});browser.page=result;
  }
  render();
}
