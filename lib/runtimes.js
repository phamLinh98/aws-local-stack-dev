const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const docker = require('./docker');
const definitions = {
  java: { image:'eclipse-temurin:21-jdk', file:'Handler.java', command:'mkdir -p classes; javac -d classes Handler.java Main.java $(find layers -name "*.java"); java -cp classes Main',
    source:'public class Handler {\n  public static String handle(String event) {\n    System.err.println("Hello from Java 21");\n    return event; // Return a JSON string\n  }\n}\n',
    files:{'Main.java':'import java.nio.file.*; public class Main { public static void main(String[] args) throws Exception { String event=Files.readString(Path.of("event.json")); System.out.println("__LAB_RESULT__"+Handler.handle(event)); } }'} },
  dotnet: { image:'mcr.microsoft.com/dotnet/sdk:8.0', file:'Handler.cs', command:'DOTNET_CLI_HOME=/tmp dotnet build --nologo -o out >&2 && dotnet out/Function.dll',
    source:'using System;\nusing System.Text.Json;\npublic static class Handler {\n  public static object Handle(JsonElement input) {\n    Console.Error.WriteLine("Hello from C# / .NET 8");\n    return new { message = "Hello local", input };\n  }\n}\n',
    files:{'Function.csproj':'<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup></Project>', 'Program.cs':'using System.Text.Json; var input=JsonSerializer.Deserialize<JsonElement>(File.ReadAllText("event.json")); Console.WriteLine("__LAB_RESULT__"+JsonSerializer.Serialize(Handler.Handle(input)));', 'NuGet.Config':'<configuration><packageSources><clear /></packageSources></configuration>'} },
  go: { image:'golang:1.24', file:'handler.go', command:'find layers -name \"*.go\" -exec cp {} . \\; ; GOCACHE=/tmp/go-cache GOPATH=/tmp/go GO111MODULE=off go run .',
    source:'package main\n\nimport ("encoding/json"; "fmt"; "os")\n\nfunc Handle(event json.RawMessage) (any, error) {\n  fmt.Fprintln(os.Stderr, "Hello from Go")\n  return map[string]any{"message":"Hello local", "input":event}, nil\n}\n',
    files:{'main.go':'package main\nimport("encoding/json";"fmt";"os")\nfunc main(){ b,e:=os.ReadFile("event.json");if e!=nil{panic(e)};v,e:=Handle(json.RawMessage(b));if e!=nil{panic(e)};out,e:=json.Marshal(v);if e!=nil{panic(e)};fmt.Println("__LAB_RESULT__"+string(out)) }'} },
};
const nodeSource='exports.handler = async (event) => {\n  console.log("Hello from Node.js");\n  return { message: "Hello local", input: event };\n};\n';
function safeFiles(files) {
  if (!files || typeof files !== 'object' || Array.isArray(files)) throw new Error('Layer files must be an object mapping paths to text.');
  for(const [name,content] of Object.entries(files)) {
    if (!name || name.length>200 || name.includes('\\') || path.posix.isAbsolute(name) || name.split('/').some(p=>!p || p==='..' || p==='.') || typeof content!=='string') throw new Error('Layer requires safe relative file paths and text contents.');
  }
  if(JSON.stringify(files).length>500000)throw new Error('Layer exceeds 500 KB.');
  return files;
}
async function writeFiles(root, files) { for(const [name,content] of Object.entries(safeFiles(files))) { const file=path.join(root,name);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,content); } }
async function invoke(runtime, source, event, { memory=512, timeout=60, layers=[], endpoint }={}) {
  const definition=definitions[runtime]; if(!definition)throw new Error('Unsupported runtime.');
  await docker.ensureImage(definition.image);await docker.network();
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'aws-lab-function-'));
  await fs.chmod(directory, 0o755);
  const container=docker.id('lambda');let created=false;
  const started=Date.now();
  try {
    await writeFiles(directory,{...definition.files,[definition.file]:source,'event.json':JSON.stringify(event)});
    await fs.mkdir(path.join(directory,'layers'),{recursive:true});
    for(const layer of layers)await writeFiles(path.join(directory,'layers',layer.name),layer.files);
    const internalEndpoint=process.env.LAB_INTERNAL_ENDPOINT || endpoint.replace(/127\.0\.0\.1|localhost/,'host.docker.internal');
    const args=['create','--name',container,'--label',`${docker.LABEL}=true`,'--label',`${docker.LABEL}.kind=lambda`,...docker.limits(memory),'--network',docker.NETWORK,'--add-host','host.docker.internal:host-gateway','--tmpfs','/tmp:rw,exec,size=384m','--env','DOTNET_CLI_TELEMETRY_OPTOUT=1','--env','DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1','--env','AWS_ACCESS_KEY_ID=test','--env','AWS_SECRET_ACCESS_KEY=test','--env',`AWS_REGION=${process.env.AWS_REGION||'us-east-1'}`,'--env',`AWS_ENDPOINT_URL=${internalEndpoint}`,definition.image,'sh','-c',`mkdir -p /tmp/work; cp -R /src/. /tmp/work/; cd /tmp/work; ${definition.command}`];
    await docker.command(args); created=true;
    await docker.command(['cp',`${directory}${path.sep}.`,`${container}:/src`]);
    let logs;
    try { logs=await docker.command(['start','-a',container],{timeout:timeout*1000,maxOutput:256000}); }
    catch(error){return {error:error.message,logs:error.message,durationMs:Date.now()-started};}
    const lines=logs.stdout.split('\n'), resultLine=lines.findLast(line=>line.startsWith('__LAB_RESULT__'));
    const containerState=await docker.inspect(container);
    const output={logs:(logs.stderr+'\n'+lines.filter(l=>!l.startsWith('__LAB_RESULT__')).join('\n')).slice(-64000),durationMs:Date.now()-started};
    if(containerState.State.ExitCode!==0 || !resultLine)return {...output,error:`Runtime exited with code ${containerState.State.ExitCode}. Check compiler/runtime logs.`};
    try { return {...output,result:JSON.parse(resultLine.slice('__LAB_RESULT__'.length))}; } catch {return {...output,error:'Handler result must be valid JSON.'};}
  } finally { if(created)await docker.command(['rm','-f',container]).catch(()=>{});await fs.rm(directory,{recursive:true,force:true}); }
}
module.exports={definitions,nodeSource,invoke,safeFiles,writeFiles};
