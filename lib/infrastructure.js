const docker = require('./docker');
const crypto = require('node:crypto');
const runtime = require('./runtimes');
const validName = value => { if(typeof value!=='string'||!/^[a-z][a-z0-9-]{0,48}$/.test(value))throw new Error('Use 1–49 lowercase letters, numbers and hyphens, beginning with a letter.');return value; };
const memoryOf = value => {const memory=Number(value||128);if(![128,512,1024].includes(memory))throw new Error('Memory must be 128, 512 or 1024 MB.');return memory;};
function installInfrastructure(app, ctx) {
  const { extra, record, persist, jsonBody }=ctx;
  extra.workspaceId ||= 'lab-'+crypto.randomBytes(5).toString('hex');
  for(const key of ['instances','repositories','clusters','databases','logGroups','alarms'])extra[key] ||= new Map();
  extra.metrics ||= [];
  let chain=Promise.resolve();
  function serial(fn){const result=chain.then(fn);chain=result.catch(()=>{});return result;}
  const labels=kind=>['--label',`${docker.LABEL}=true`,'--label',`${docker.LABEL}.kind=${kind}`,'--label',`${docker.LABEL}.workspace=${extra.workspaceId}`];
  const find=(kind,name)=>{const value=extra[kind].get(name);if(!value)throw new Error('Resource does not exist.');return value;};
  const log=(group,message)=>{const entries=extra.logGroups.get(group)||[];entries.push({timestamp:Date.now(),message:String(message).slice(-64000)});extra.logGroups.set(group,entries.slice(-500));};
  ctx.log=log;
  ctx.metric=(name,value,resource)=>{extra.metrics.push({name,value,resource,timestamp:Date.now()});extra.metrics=extra.metrics.slice(-2000);};
  async function ec2Budget(memory, except) {
    let allocated=0;
    for(const c of await docker.list('ec2')){const info=await docker.inspect(c.ID);if(info.State.Running&&info.Name.slice(1)!==except)allocated+=info.HostConfig.Memory/1024/1024;}
    if(allocated+memory>1024)throw new Error(`EC2 has ${allocated} MB allocated. Total running EC2 memory cannot exceed 1024 MB.`);
    return allocated;
  }
  async function containerStatus(container){try{const info=await docker.inspect(container);return {status:info.State.Status,ports:info.NetworkSettings.Ports,exitCode:info.State.ExitCode};}catch{return {status:'unavailable'};}}
  async function registry(){
    await docker.network();
    const name=extra.registry?.container||`${extra.workspaceId}-registry`;
    if(extra.registry){try{const info=await docker.inspect(name);if(!info.State.Running)await docker.command(['start',name]);return extra.registry;}catch(e){if(!e.message.includes('No such'))throw e;}}
    await docker.ensureImage('registry:2');
    const volume=`${extra.workspaceId}-registry-data`;
    await docker.command(['run','-d','--name',name,...labels('ecr'),'--memory','128m','--memory-swap','128m','--network',docker.NETWORK,'-p',`127.0.0.1:${process.env.REGISTRY_PORT||5001}:5000`,'-v',`${volume}:/var/lib/registry`,'registry:2']);
    extra.registry={container:name,volume,endpoint:`localhost:${process.env.REGISTRY_PORT||5001}`};persist();return extra.registry;
  }
  require('./terminal').installTerminal(app,ctx);
  app.get('/api/docker',async(req,res)=>res.json(await docker.available()));
  app.get('/api/runtimes',(req,res)=>res.json({node:{source:runtime.nodeSource},...Object.fromEntries(Object.entries(runtime.definitions).map(([k,v])=>[k,{image:v.image,source:v.source}]))}));
  app.post('/api/runtime/prepare',jsonBody,async(req,res)=>{const def=runtime.definitions[req.body.runtime];if(!def)throw new Error('Unknown Docker runtime.');await docker.ensureImage(def.image);res.json({ready:true,image:def.image});});
  app.get('/api/infrastructure',async(req,res)=>{
    const status=await docker.available();
    const instances=await Promise.all([...extra.instances.values()].map(async v=>({...v,...(status.available?await containerStatus(v.container):{status:'docker-offline'})})));
    const databases=await Promise.all([...extra.databases.values()].map(async({password,...v})=>({...v,...(status.available?await containerStatus(v.container):{status:'docker-offline'})})));
    const clusters=await Promise.all([...extra.clusters.values()].map(async c=>({...c,services:await Promise.all(c.services.map(async s=>({...s,tasks:await Promise.all(s.tasks.map(async t=>({...t,...(status.available?await containerStatus(t.container):{status:'docker-offline'})})))})))})));
    const latest=new Map();for(const metric of extra.metrics)latest.set(`${metric.name}:${metric.resource}`,metric);
    const alarms=[...extra.alarms.values()].map(a=>{const m=latest.get(`${a.metric}:${a.resource}`);return {...a,state:!m?'INSUFFICIENT_DATA':m.value>=a.threshold?'ALARM':'OK',lastValue:m?.value};});
    res.json({docker:status,instances,databases,clusters,repositories:[...extra.repositories.values()],registry:extra.registry,logGroups:[...extra.logGroups].map(([name,events])=>({name,events})),metrics:extra.metrics,alarms,ec2BudgetMB:1024});
  });
  app.post('/api/ec2',jsonBody,async(req,res)=>res.json(await serial(async()=>{
    const {action,name}=req.body;
    if(action==='create'){
      validName(name);if(extra.instances.has(name))throw new Error('Instance already exists.');
      const memory=memoryOf(req.body.memory),image=docker.validateImage(req.body.image||'ubuntu:24.04');
      await ec2Budget(memory);await docker.ensureImage(image);await docker.network();
      const container=docker.id('ec2');
      const command=req.body.command||['sh','-c','while true; do sleep 3600; done'];
      if(!Array.isArray(command)||!command.every(s=>typeof s==='string'))throw new Error('Command must be an array of strings.');
      await docker.command(['run','-d','--name',container,...labels('ec2'),...docker.limits(memory),'--network',docker.NETWORK,image,...command]);
      extra.instances.set(name,{name,container,image,memory,createdAt:new Date().toISOString()});record('ec2','RunInstances',name);persist();return {name,container};
    }
    const instance=find('instances',name);await docker.inspect(instance.container);
    if(action==='start'){await ec2Budget(instance.memory,instance.container);await docker.command(['start',instance.container]);}
    else if(action==='stop')await docker.command(['stop','-t','3',instance.container]);
    else if(action==='terminate'){await docker.command(['rm','-f',instance.container]);extra.instances.delete(name);}
    else if(action==='exec'){
      if(typeof req.body.command!=='string'||req.body.command.length>10000)throw new Error('Enter a shell command.');
      const result=await docker.command(['exec',instance.container,'sh','-lc',req.body.command],{timeout:15000,maxOutput:64000});log(`/ec2/${name}`,result.stdout+result.stderr);persist();return result;
    } else if(action==='commit'){
      const image=docker.validateImage(req.body.image);await docker.command(['commit',instance.container,image]);return {image};
    } else throw new Error('Unsupported EC2 action.');
    record('ec2',action,name);persist();return {ok:true};
  })));
  app.post('/api/ecr',jsonBody,async(req,res)=>res.json(await serial(async()=>{
    const {action,name}=req.body;
    if(action==='registry')return registry();
    if(action==='create'){validName(name);if(extra.repositories.has(name))throw new Error('Repository exists.');extra.repositories.set(name,{name,tags:[]});persist();return {name};}
    const repo=find('repositories',name),reg=await registry();
    const tag=req.body.tag||'latest';if(!/^[a-zA-Z0-9_.-]{1,100}$/.test(tag))throw new Error('Invalid tag.');
    const target=`${reg.endpoint}/${name}:${tag}`;
    if(action==='push'){
      const source=docker.validateImage(req.body.image);await docker.ensureImage(source);await docker.command(['tag',source,target]);await docker.command(['push',target],{timeout:600000});
      const info=JSON.parse((await docker.command(['image','inspect',target])).stdout)[0];repo.tags=repo.tags.filter(t=>t.tag!==tag);repo.tags.push({tag,image:target,digest:info.Id,size:info.Size,pushedAt:new Date().toISOString()});
    }else if(action==='pull')await docker.command(['pull',target],{timeout:600000});
    else throw new Error('Unsupported ECR action.');
    record('ecr',action,target);persist();return {image:target};
  })));
  async function scaleService(cluster,service,count){
    if(!Number.isInteger(count)||count<0||count>4)throw new Error('Desired count must be 0–4.');
    await docker.ensureImage(service.image);await docker.network();
    for(const task of [...service.tasks]) {const state=await containerStatus(task.container);if(state.status==='unavailable'){service.tasks=service.tasks.filter(t=>t.container!==task.container);}}
    while(service.tasks.length>count){const task=service.tasks.at(-1);await docker.command(['rm','-f',task.container]);service.tasks.pop();persist();}
    while(service.tasks.length<count){
      const container=docker.id('ecs');const portArgs=service.port?['-p',`127.0.0.1::${service.port}`]:[];
      await docker.command(['run','-d','--name',container,...labels('ecs'),...docker.limits(service.memory),'--network',docker.NETWORK,...portArgs,service.image,...service.command]);
      service.tasks.push({container});persist();
    }
    for(const task of service.tasks){const state=await docker.inspect(task.container);if(!state.State.Running)await docker.command(['start',task.container]);}
    service.desired=count;record('ecs','UpdateService',`${cluster.name}/${service.name}`);persist();return service;
  }
  app.post('/api/ecs',jsonBody,async(req,res)=>res.json(await serial(async()=>{
    const {action,name}=req.body;
    if(action==='create'){validName(name);if(extra.clusters.has(name))throw new Error('Cluster exists.');extra.clusters.set(name,{name,services:[]});persist();return {name};}
    const cluster=find('clusters',name);
    if(action==='service'){
      const serviceName=validName(req.body.service);if(cluster.services.some(s=>s.name===serviceName))throw new Error('Service exists.');
      const port=Number(req.body.port||0);if(!Number.isInteger(port)||port<0||port>65535)throw new Error('Invalid container port.');
      const command=req.body.command||[];if(!Array.isArray(command)||!command.every(s=>typeof s==='string'))throw new Error('Command must be a JSON array.');
      const service={name:serviceName,image:docker.validateImage(req.body.image),memory:memoryOf(req.body.memory),port,command,tasks:[],desired:0};
      cluster.services.push(service);persist();return scaleService(cluster,service,Number(req.body.replicas??1));
    }
    const service=cluster.services.find(s=>s.name===req.body.service);if(!service)throw new Error('Service does not exist.');
    if(action==='scale')return scaleService(cluster,service,Number(req.body.replicas));
    if(action==='logs'){const logs=await Promise.all(service.tasks.map(async t=>(await docker.command(['logs','--tail','100',t.container])).stdout));log(`/ecs/${name}/${service.name}`,logs.join('\n'));persist();return {logs:logs.join('\n')};}
    throw new Error('Unsupported ECS action.');
  })));
  app.post('/api/rds',jsonBody,async(req,res)=>res.json(await serial(async()=>{
    const {action,name}=req.body;
    if(action==='create'){
      validName(name);if(extra.databases.has(name))throw new Error('Database already exists.');
      const engine=req.body.engine||'postgres';if(!['postgres','mysql'].includes(engine))throw new Error('Choose PostgreSQL or MySQL.');
      const image=engine==='postgres'?'postgres:16-alpine':'mysql:8.4';
      const password=crypto.randomBytes(18).toString('hex');const container=docker.id('rds'),volume=`${container}-data`;
      const memory=engine==='mysql'?512:128;
      const variables=engine==='postgres'?['-e',`POSTGRES_PASSWORD=${password}`,'-e','POSTGRES_USER=lab','-e','POSTGRES_DB=lab']:['-e',`MYSQL_ROOT_PASSWORD=${password}`,'-e','MYSQL_DATABASE=lab'];
      const port=engine==='postgres'?5432:3306;
      await docker.ensureImage(image);await docker.network();
      await docker.command(['run','-d','--name',container,...labels('rds'),'--memory',`${memory}m`,'--memory-swap',`${memory}m`,'--network',docker.NETWORK,'-p',`127.0.0.1::${port}`,'-v',`${volume}:${engine==='postgres'?'/var/lib/postgresql/data':'/var/lib/mysql'}`,...variables,image]);
      extra.databases.set(name,{name,engine,image,container,volume,password,memory,port});record('rds','CreateDBInstance',name);persist();return {name};
    }
    const database=find('databases',name);await docker.inspect(database.container);
    if(action==='credentials'){return {user:database.engine==='postgres'?'lab':'root',password:database.password,database:'lab',host:'127.0.0.1',...await containerStatus(database.container)};}
    if(action==='start'||action==='stop'){await docker.command([action,database.container]);record('rds',action,name);persist();return {ok:true};}
    const args=database.engine==='postgres'?['exec','-i','-e',`PGPASSWORD=${database.password}`,database.container,'psql','-U','lab','-d','lab','-v','ON_ERROR_STOP=1']:['exec','-i','-e',`MYSQL_PWD=${database.password}`,database.container,'mysql','-uroot','lab'];
    if(action==='tables'||action==='browse')return require('./rds-browser').browse(database,req.body);
    if(action==='query'){
      if(typeof req.body.sql!=='string'||req.body.sql.length>100000)throw new Error('SQL is required (maximum 100 KB).');
      const result=await docker.command(args,{input:req.body.sql,timeout:15000,maxOutput:256000});log(`/rds/${name}`,'SQL executed successfully');persist();return result;
    }
    throw new Error('Unsupported RDS action.');
  })));
  app.post('/api/cloudwatch',jsonBody,async(req,res)=>{
    const {action}=req.body;
    if(action==='alarm'){
      const name=validName(req.body.name),threshold=Number(req.body.threshold);if(!Number.isFinite(threshold))throw new Error('Threshold must be a number.');
      if(!['Invocations','Errors','Duration','MemoryMB','CPUPercent'].includes(req.body.metric))throw new Error('Unsupported metric.');
      extra.alarms.set(name,{name,metric:req.body.metric,resource:String(req.body.resource),threshold});persist();return res.json({name});
    }
    if(action==='sample'){
      const containers=await docker.list();
      for(const container of containers){const info=await docker.inspect(container.ID);if(info.State.Running){const result=await docker.command(['stats','--no-stream','--format','{{json .}}',container.ID]);const stats=JSON.parse(result.stdout);ctx.metric('CPUPercent',parseFloat(stats.CPUPerc),container.Names);const match=/([\d.]+)([KMG]?i?B)/.exec(stats.MemUsage);if(match){const units={B:1/1048576,KiB:1/1024,MiB:1,GiB:1024,kB:1/1000,MB:1,GB:1000};ctx.metric('MemoryMB',Number(match[1])*(units[match[2]]||1),container.Names);}}}
      persist();return res.json({sampled:true});
    }
    throw new Error('Unsupported CloudWatch action.');
  });
}
module.exports={installInfrastructure};
