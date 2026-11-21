const crypto = require('node:crypto');
const { safeFiles } = require('./runtimes');
function installFeatures(app, ctx) {
  const {extra, jsonBody, persist, record, getState}=ctx;
  for(const key of ['bucketConfig','objectVersions','functionConfig','layers','secretVersions','queueConfig','tableBackups'])extra[key] ||= new Map();
  const historyKey=(bucket,key)=>JSON.stringify([bucket,key]);
  const bucketFor=name=>{const bucket=getState().buckets.get(name);if(!bucket)throw new Error('Bucket does not exist.');return bucket;};
  ctx.putObject=(bucketName,key,object)=>{
    const bucket=bucketFor(bucketName),config=extra.bucketConfig.get(bucketName)||{},id=config.versioning?crypto.randomUUID():'null';
    const value={...object,versionId:id};
    const history=extra.objectVersions.get(historyKey(bucketName,key))||[];
    if(id==='null'){const index=history.findIndex(v=>v.versionId==='null');if(index>=0)history.splice(index,1);}
    history.unshift(value);extra.objectVersions.set(historyKey(bucketName,key),history);bucket.set(key,value);return id;
  };
  ctx.deleteObject=(bucketName,key,versionId)=>{
    const bucket=bucketFor(bucketName),hkey=historyKey(bucketName,key),history=extra.objectVersions.get(hkey)||[];
    if(versionId){
      const index=history.findIndex(v=>v.versionId===versionId);if(index<0)throw new Error('Version not found.');history.splice(index,1);
      if(history[0]&&!history[0].deleteMarker)bucket.set(key,history[0]);else bucket.delete(key);
    }else if(extra.bucketConfig.get(bucketName)?.versioning){history.unshift({versionId:crypto.randomUUID(),deleteMarker:true,modified:new Date().toISOString()});bucket.delete(key);}
    else {bucket.delete(key);const index=history.findIndex(v=>v.versionId==='null');if(index>=0)history.splice(index,1);}
    extra.objectVersions.set(hkey,history);
  };
  ctx.getVersion=(bucket,key,id)=>{const version=(extra.objectVersions.get(historyKey(bucket,key))||[]).find(v=>v.versionId===id);if(!version||version.deleteMarker)throw new Error('Object version not found.');return version;};
  ctx.sweep=(now=Date.now())=>{
    let expired=0;
    for(const table of getState().tables.values())if(table.ttlAttribute){const before=table.items.length;table.items=table.items.filter(i=>!i[table.ttlAttribute]?.N||Number(i[table.ttlAttribute].N)>now/1000);expired+=before-table.items.length;}
    for(const [name,config] of extra.bucketConfig){
      const bucket=getState().buckets.get(name);if(!bucket)continue;
      const rule=config.lifecycle;if(!rule)continue;
      for(const [key,object] of bucket){if(key.startsWith(rule.prefix||'')&&rule.expirationDays>0&&new Date(object.modified).getTime()+rule.expirationDays*86400000<=now){ctx.deleteObject(name,key);expired++;}}
      if(rule.noncurrentDays>0)for(const [hkey,history]of extra.objectVersions){const [bucketName,key]=JSON.parse(hkey);if(bucketName!==name||!key.startsWith(rule.prefix||''))continue;extra.objectVersions.set(hkey,history.filter((v,i)=>i===0||new Date(history[i-1].modified).getTime()+rule.noncurrentDays*86400000>now));}
    }
    return expired;
  };
  app.post('/api/bucket-config',jsonBody,(req,res)=>{
    const {name,versioning,lifecycle}=req.body;const bucket=bucketFor(name);
    if(lifecycle && (![lifecycle.expirationDays,lifecycle.noncurrentDays].every(v=>v===undefined||(Number.isInteger(v)&&v>=0&&v<=36500))||typeof (lifecycle.prefix||'')!=='string'))throw new Error('Lifecycle ages must be integer days, 0 to disable.');
    for(const [key,object]of bucket)if(!extra.objectVersions.has(historyKey(name,key)))extra.objectVersions.set(historyKey(name,key),[{...object,versionId:'null'}]);
    extra.bucketConfig.set(name,{versioning:!!versioning,lifecycle:lifecycle||null});record('s3','PutBucketConfiguration',name);res.json({ok:true});
  });
  app.get('/api/buckets/:name/versions',(req,res)=>{
    bucketFor(req.params.name);const versions=[];
    for(const [key,history]of extra.objectVersions){const [bucketName,objectKey]=JSON.parse(key);if(bucketName===req.params.name)history.forEach((v,i)=>versions.push({key:objectKey,versionId:v.versionId,deleteMarker:!!v.deleteMarker,size:v.body?.length||0,modified:v.modified,isLatest:i===0}));}
    res.json({versions});
  });
  app.post('/api/lifecycle/run',jsonBody,(req,res)=>{
    const daysAhead=Number(req.body.daysAhead||0);if(!Number.isInteger(daysAhead)||daysAhead<0||daysAhead>3650)throw new Error('Use 0–3650 days ahead.');
    const expired=ctx.sweep(Date.now()+daysAhead*86400000);record('s3','LifecycleSweep',`${expired} current objects/items expired`);res.json({expired});
  });
  app.post('/api/layers',jsonBody,(req,res)=>{
    const {name,runtime,files}=req.body;if(!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name||''))throw new Error('Invalid layer name.');if(!['node','java','dotnet','go'].includes(runtime))throw new Error('Unsupported runtime.');
    safeFiles(files);const versions=extra.layers.get(name)||[];const version=versions.length+1;versions.push({name,version,runtime,files,createdAt:new Date().toISOString()});extra.layers.set(name,versions);record('lambda','PublishLayerVersion',`${name}:${version}`);res.json({name,version});
  });
  app.post('/api/table-config',jsonBody,(req,res)=>{
    const {name,ttlAttribute}=req.body;const table=getState().tables.get(name);if(!table)throw new Error('Table not found.');
    if(ttlAttribute && !/^[a-zA-Z0-9_]{1,128}$/.test(ttlAttribute))throw new Error('Invalid TTL field.');table.ttlAttribute=ttlAttribute||null;res.json({ok:true});
  });
  app.post('/api/table-backup',jsonBody,(req,res)=>{
    const {name,action,id}=req.body;const table=getState().tables.get(name);if(!table)throw new Error('Table not found.');
    if(action==='create'){const backupId=crypto.randomUUID();extra.tableBackups.set(backupId,{id:backupId,name,at:new Date().toISOString(),table:structuredClone(table)});res.json({id:backupId});}
    else if(action==='restore'){const backup=extra.tableBackups.get(id);if(!backup||backup.name!==name)throw new Error('Backup not found for this table.');getState().tables.set(name,structuredClone(backup.table));res.json({ok:true});}
    else throw new Error('Unsupported backup action.');
  });
  app.post('/api/queue-config',jsonBody,(req,res)=>{
    const {name,dlq,visibilityTimeout=30,maxReceiveCount=3}=req.body;if(!getState().queues.has(name))throw new Error('Queue not found.');if(dlq && (!getState().queues.has(dlq)||dlq===name))throw new Error('Choose a different existing dead-letter queue.');
    if(!Number.isInteger(visibilityTimeout)||visibilityTimeout<0||visibilityTimeout>43200||!Number.isInteger(maxReceiveCount)||maxReceiveCount<1||maxReceiveCount>1000)throw new Error('Invalid visibility timeout or receive count.');
    extra.queueConfig.set(name,{dlq:dlq||null,visibilityTimeout,maxReceiveCount});res.json({ok:true});
  });
  app.get('/api/secrets/:name/versions',(req,res)=>res.json({versions:(extra.secretVersions.get(req.params.name)||[]).map(({value,...v})=>v)}));
  app.post('/api/secret-restore',jsonBody,(req,res)=>{
    const {name,id}=req.body,version=(extra.secretVersions.get(name)||[]).find(v=>v.id===id);if(!version)throw new Error('Secret version not found.');
    ctx.saveSecret(name,version.value);record('secrets','RestoreVersion',name);res.json({ok:true});
  });
  ctx.saveSecret=(name,value)=>{
    const versions=extra.secretVersions.get(name)||[];
    if(!versions.length&&getState().secrets.has(name))versions.push({id:crypto.randomUUID(),at:new Date().toISOString(),value:getState().secrets.get(name)});
    versions.push({id:crypto.randomUUID(),at:new Date().toISOString(),value});extra.secretVersions.set(name,versions);getState().secrets.set(name,value);
  };
}
module.exports={installFeatures};
