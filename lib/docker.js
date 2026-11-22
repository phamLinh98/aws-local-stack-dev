const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const LABEL = 'local.aws.lab';
const NETWORK = process.env.LAB_NETWORK || 'local-aws-lab';
function command(args, { input, timeout = 120000, maxOutput = 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.DOCKER_BIN || 'docker', args, { shell: false, windowsHide: true });
    let stdout = '', stderr = '', ended = false;
    const done = (error, result) => { if (ended) return; ended = true; clearTimeout(timer); error ? reject(error) : resolve(result); };
    const timer = setTimeout(() => { child.kill(); done(new Error(`Docker command timed out: ${args[0]}`)); }, timeout);
    child.stdout.on('data', d => { stdout += d; if (stdout.length > maxOutput) { child.kill(); done(new Error('Docker output exceeded limit.')); } });
    child.stderr.on('data', d => { stderr = (stderr + d).slice(-maxOutput); });
    child.on('error', e => done(new Error(`Docker unavailable: ${e.message}. Start Docker Desktop or Colima.`)));
    child.on('close', code => done(code ? new Error(stderr.trim() || `Docker ${args[0]} failed (${code})`) : null, { stdout, stderr }));
    child.stdin.on('error', () => {});
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  });
}
async function available() { try { const r = await command(['info','--format','{{json .ServerVersion}}'], {timeout:5000}); return { available:true, version:JSON.parse(r.stdout) }; } catch(e) { return {available:false,message:e.message}; } }
async function network() { try { await command(['network','inspect',NETWORK]); } catch { await command(['network','create','--label',`${LABEL}=true`,NETWORK]); } }
async function ensureImage(image) { validateImage(image); try { await command(['image','inspect',image]); } catch { await command(['pull',image],{timeout:600000}); } }
function validateImage(image) { if (typeof image !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,240}$/.test(image)) throw new Error('Invalid Docker image reference.'); return image; }
function id(prefix) { return `aws-lab-${prefix}-${crypto.randomBytes(6).toString('hex')}`; }
async function inspect(name) { const r = await command(['inspect',name]); const value = JSON.parse(r.stdout)[0]; if (value.Config.Labels?.[LABEL] !== 'true') throw new Error('This container is not managed by Local AWS Lab.'); return value; }
async function list(kind) { const args=['ps','-a','--filter',`label=${LABEL}=true`]; if(kind)args.push('--filter',`label=${LABEL}.kind=${kind}`); args.push('--format','{{json .}}'); const r=await command(args); return r.stdout.trim().split('\n').filter(Boolean).map(s=>JSON.parse(s)); }
const limits = memory => ['--memory',`${memory}m`,'--memory-swap',`${memory}m`,'--cpus','1','--pids-limit','128','--cap-drop','ALL','--security-opt','no-new-privileges'];
module.exports = { command, available, network, ensureImage, validateImage, id, inspect, list, limits, LABEL, NETWORK };
