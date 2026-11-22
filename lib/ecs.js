const crypto=require('node:crypto');
const docker=require('./docker');
const FARGATE_SIZES={256:[512,1024,2048],512:[1024,2048,3072,4096]};
function resources(input){
  const launchType=input.launchType||'LOCAL';
  if(!['LOCAL','FARGATE'].includes(launchType))throw new Error('Choose LOCAL or FARGATE launch type.');
  const cpu=Number(input.cpu??(launchType==='FARGATE'?256:1024));
  const memory=Number(input.memory??(launchType==='FARGATE'?512:128));
  if(launchType==='FARGATE'){
    if(!FARGATE_SIZES[cpu]?.includes(memory))throw new Error('Supported local Fargate sizes: 256 CPU / 512–2048 MB, or 512 CPU / 1024–4096 MB.');
  }else if(cpu!==1024||![128,512,1024].includes(memory))throw new Error('Local Docker tasks use 1 vCPU and 128/512/1024 MB.');
  return {launchType,cpu,memory};
}
function event(service,message){service.events||=[];service.events.unshift({at:new Date().toISOString(),message});service.events=service.events.slice(0,40);}
async function taskStatus(task,service){
  try{
    const info=await docker.inspect(task.container);
    return {...task,taskId:task.taskId||task.container,launchType:service.launchType||'LOCAL',status:info.State.Status,lastStatus:info.State.Running?'RUNNING':info.State.Status==='created'?'PENDING':'STOPPED',containerId:info.Id,containerName:info.Name.replace(/^\//,''),image:info.Config.Image,imageId:info.Image,ports:info.NetworkSettings.Ports,cpu:service.cpu||1024,memoryMB:info.HostConfig.Memory/1048576,startedAt:info.State.StartedAt,finishedAt:info.State.FinishedAt,exitCode:info.State.ExitCode,oomKilled:info.State.OOMKilled,reason:info.State.Error||null,health:info.State.Health?.Status||'not-configured',networks:Object.entries(info.NetworkSettings.Networks||{}).map(([name,n])=>({name,ip:n.IPAddress}))};
  }catch(e){return {...task,lastStatus:'UNKNOWN',status:'unavailable',reason:e.message};}
}
async function clusterStatus(cluster,online){
  const services=await Promise.all(cluster.services.map(async service=>{
    const tasks=await Promise.all(service.tasks.map(t=>online?taskStatus(t,service):{...t,lastStatus:'UNKNOWN',status:'docker-offline'}));
    const running=tasks.filter(t=>t.lastStatus==='RUNNING').length,pending=tasks.filter(t=>t.lastStatus==='PENDING').length;
    return {...service,launchType:service.launchType||'LOCAL',cpu:service.cpu||1024,tasks,running,pending,stopped:tasks.filter(t=>t.lastStatus==='STOPPED').length,deploymentStatus:!online?'UNKNOWN':running===service.desired?'STABLE':pending?'IN_PROGRESS':'DEGRADED'};
  }));
  return {...cluster,status:online?'ACTIVE':'UNKNOWN',services,running:services.reduce((n,s)=>n+s.running,0),pending:services.reduce((n,s)=>n+s.pending,0),taskCount:services.reduce((n,s)=>n+s.tasks.length,0)};
}
const taskId=()=>crypto.randomBytes(16).toString('hex');
module.exports={resources,event,taskStatus,clusterStatus,taskId};
