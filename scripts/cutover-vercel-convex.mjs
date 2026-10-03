// Operator-only orchestration. Tests inject commands; no provider calls at import.
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, rmdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { inspect } from './migrate-storage.mjs';
const policy = JSON.parse(readFileSync(new URL('./production-release.json', import.meta.url), 'utf8'));
const repository = 'stawuah/chainpay-mcp-sdk';
const marker = 'CHAINPAY_CUTOVER_WRITES_OPENED';
const root = resolve(import.meta.dirname, '..');
const hash = value => createHash('sha256').update(value).digest('hex');
const scriptHash = hash(readFileSync(new URL(import.meta.url)));
const die = message => { throw new Error(message); };
export function validateTarget(env) {
  const name = new URL(policy.convexSite).hostname.split('.')[0];
  if (!env.CONVEX_DEPLOY_KEY?.startsWith(`prod:${name}|`) || !env.CONVEX_DEPLOY_KEY.split('|')[1]) die('Expected the production deploy key for the reviewed Convex target');
  if (env.CHAINPAY_CONVEX_SITE_URL !== policy.convexSite) die('Convex site does not match the reviewed production target');
  const secrets = ['BACKEND','MCP','MIGRATION'].map(role => env[`CHAINPAY_CONVEX_${role}_SECRET`]);
  if (secrets.some(secret => !secret || secret.length < 32) || new Set(secrets).size !== 3) die('Three distinct service secrets of at least 32 characters are required');
}
function execute(command, args, options = {}) {
  try { return execFileSync(command, args, { cwd:root, encoding:'utf8', stdio:['pipe','pipe','pipe'], ...options }).trim(); }
  catch { die(`${command} failed; no subsequent step ran. Inspect provider status privately, then retry the same step.`); }
}
export async function cutover(step, {env=process.env, run=execute, confirm=async () => {
  const io=createInterface({input:process.stdin,output:process.stdout});
  try { return await io.question('Both Render writers and keep-alive are suspended, in-flight work drained, and unresolved operations recorded? Type PAUSED: '); } finally { io.close(); }
}, log=console.log}={}) {
  if (!['preflight','migrate','switch','verify','open','smoke','abort'].includes(step)) die('Choose preflight, migrate, switch, verify, open, smoke, or abort');
  validateTarget(env);
  const out=resolve(env.CHAINPAY_CUTOVER_DIR ?? `.migration/cutover-${new Date().toISOString().slice(0,10)}`);
  mkdirSync(out,{recursive:true,mode:0o700});
  const lock=join(out,'.lock');
  try { mkdirSync(lock); } catch { die('Another step is active or interrupted. Confirm it stopped before removing the cutover .lock directory.'); }
  const stateFile=join(out,'state.json');
  let state=null;
  const save=patch=>{state={...state,...patch};writeFileSync(`${stateFile}.tmp`,JSON.stringify(state,null,2)+'\n',{mode:0o600});renameSync(`${stateFile}.tmp`,stateFile);};
  const command=(name,args,options={})=>run(name,args,{env,...options});
  const convex=(...args)=>command('npx',['--no-install','convex',...args]);
  const migrate=(...args)=>JSON.parse(command(process.execPath,['scripts/migrate-storage.mjs',...args]));
  const maintenance=()=>{if(convex('env','get','CHAINPAY_MAINTENANCE')!=='true')die('Production Convex must remain in maintenance');};
  const notOpened=()=>{if(convex('env','get',marker))die('Writes may already have opened. Pause and reconcile using a fresh Convex export; never resume stale Neon.');};
  const snapshot=async(name,operation)=>{
    // A failed export never becomes a completed checkpoint. Keep incomplete
    // files for diagnosis; retries use a fresh exclusive filename.
    const temporary=join(out,`${name}.${randomUUID()}.partial`), final=join(out,name);
    migrate(operation,temporary);await inspect(temporary);renameSync(temporary,final);return final;
  };
  const integrity=async()=>{
    if(!state?.sourceHash || !state?.roundtripHash)die('Migration has not passed verification');
    for(const [name,digest] of [['source.ndjson',state.sourceHash],['roundtrip.ndjson',state.roundtripHash]]) {
      const file=join(out,name);await inspect(file);if(hash(readFileSync(file))!==digest)die('Snapshot changed since verification');
    }
    if(migrate('compare',join(out,'source.ndjson'),join(out,'roundtrip.ndjson')).equal!==true)die('Migration comparison failed');
  };
  const deployments=()=>{
    if(!/^[a-f0-9]{40}$/.test(state.releaseSha??''))die('Run verify with CHAINPAY_RELEASE_SHA set to the merged release revision');
    const sha=state.releaseSha;
    const runs=JSON.parse(command('gh',['api',`repos/${repository}/actions/workflows/deploy-vercel.yml/runs?head_sha=${sha}&per_page=100`])).workflow_runs;
    const latest=runs.filter(r=>r.head_sha===sha && r.head_branch==='master' && r.head_repository?.full_name===repository).sort((a,b)=>b.id-a.id)[0];
    if(!latest || latest.status!=='completed' || latest.conclusion!=='success')die('The release deployment workflow has not succeeded for this revision');
    const ids={};
    for(const [project,origin] of [['chainpay-relay',policy.relayOrigin],['chainpay-mcp',policy.mcpOrigin],['chainpay-web',policy.webOrigin]]) {
      const alias=JSON.parse(command('vercel',['inspect',origin,'--format=json','--scope','chainpay']));
      if(!/^dpl_[a-zA-Z0-9]+$/.test(alias.id??''))die(`Invalid deployment identity for ${project}`);
      // CLI inspect intentionally omits meta; query the resolved deployment ID.
      const deployment=JSON.parse(command('vercel',['api',`/v13/deployments/${alias.id}`,'--scope','chainpay','--raw']));
      if(deployment.id!==alias.id)die(`Deployment identity changed for ${project}`);
      if(deployment.readyState!=='READY' || deployment.target!=='production' || deployment.name!==project || deployment.meta?.githubCommitSha!==sha)die(`Current ${project} alias does not serve the ready production release`);
      ids[project]=deployment.id;
    }
    return ids;
  };
  try {
    let unreadable=false;
    try { state=existsSync(stateFile)?JSON.parse(readFileSync(stateFile,'utf8')):null; }
    catch { unreadable=true; if(step!=='abort')die('Unreadable checkpoint; abort remains available to pause production'); }
    if(step==='abort') {
      // The remote marker is set BEFORE opening. Missing local files cannot
      // turn an uncertain opening into permission to resume the old database.
      convex('env','set','CHAINPAY_MAINTENANCE','true');
      convex('env','remove','CHAINPAY_CONVEX_MIGRATION_ENABLED');
      const opened=convex('env','get',marker);
      save({phase:'aborted',target:policy.convexSite,scriptHash,mayHaveOpened:unreadable||Boolean(opened)||Boolean(state?.mayHaveOpened)});
      if(state.mayHaveOpened)die('Convex is paused. Writes may have occurred: keep Render suspended, export fresh Convex state and restore into an empty migrated PostgreSQL target before rollback.');
      log('Convex is paused. Cancel or wait for any in-flight deployment; keep Vercel traffic closed. Kwasi may resume Render using unchanged Neon. Use a new cutover directory for another attempt.');return;
    }
    if(state && (state.target!==policy.convexSite || state.scriptHash!==scriptHash))die('Checkpoint target or cutover script changed; reconcile this attempt before proceeding');
    if(state?.phase==='aborted')die('This attempt was aborted; reconcile it and use a new cutover directory');
    if(step==='preflight') {
      if(state)die('Preflight already completed; continue this attempt or abort it');
      maintenance();notOpened();
      for(const role of ['BACKEND','MCP','MIGRATION'])if(convex('env','get',`CHAINPAY_CONVEX_${role}_SECRET`)!==env[`CHAINPAY_CONVEX_${role}_SECRET`])die(`${role} service secret does not match the selected deployment`);
      if(await confirm()!=='PAUSED')die('Writer pause was not confirmed');
      convex('env','set','CHAINPAY_CONVEX_MIGRATION_ENABLED','true');
      const before=await snapshot('prod-before.ndjson','export-convex');
      const tables=await inspect(before);
      if(Object.values(tables).some(table=>table.count!==0))die('Production migration tables are not empty; no successful preflight was recorded');
      save({phase:'preflight',target:policy.convexSite,scriptHash,group:policy.group,startedAt:new Date().toISOString()});
    } else {
      if(!state)die('Run successful preflight first');
      if(step==='migrate') {
        if(!['preflight','migrated'].includes(state.phase))die('Migration is only allowed before switching');
        maintenance();notOpened();
        convex('env','set','CHAINPAY_CONVEX_MIGRATION_ENABLED','true');
        const source=join(out,'source.ndjson');
        if(!state.sourceHash) {
          if(!env.CHAINPAY_SOURCE_DATABASE_URL)die('CHAINPAY_SOURCE_DATABASE_URL is required');
          await snapshot('source.ndjson','export-postgres');
          save({sourceHash:hash(readFileSync(source))});
        }
        await inspect(source);if(hash(readFileSync(source))!==state.sourceHash)die('Source snapshot changed; do not retry with different source data');
        migrate('import-convex',source);migrate('import-convex',source,'--apply');
        const roundtrip=await snapshot('roundtrip.ndjson','export-convex');
        if(migrate('compare',source,roundtrip).equal!==true)die('Migration comparison failed');
        convex('env','remove','CHAINPAY_CONVEX_MIGRATION_ENABLED');
        save({phase:'migrated',roundtripHash:hash(readFileSync(roundtrip))});
      } else if(step==='switch') {
        if(!['migrated','switched'].includes(state.phase))die('Run successful migration before switching');
        maintenance();notOpened();await integrity();
        // Each assignment is idempotent; a partial failure can rerun switch.
        for(const project of ['chainpay-relay','chainpay-mcp','chainpay-web']) {
          const dir=mkdtempSync(join(tmpdir(),'chainpay-cutover-env-'));
          try {
            command('vercel',['link','--yes','--project',project,'--scope','chainpay','--cwd',dir]);
            const values={CHAINPAY_RELEASE_ENVIRONMENT:'production',CHAINPAY_CONVEX_DEPLOYMENT_TYPE:'prod',CHAINPAY_RELEASE_GROUP:policy.group};
            if(project==='chainpay-web')Object.assign(values,{VITE_CHAINPAY_BACKEND_URL:policy.relayOrigin,VITE_CHAINPAY_RPC_URL:`${policy.relayOrigin}/rpc`,VITE_CHAINPAY_MCP_URL:`${policy.mcpOrigin}/mcp`,VITE_CHAINPAY_AGENT_URL:`${policy.mcpOrigin}/agent/chat`});
            else Object.assign(values,{CHAINPAY_STORAGE:'convex',CHAINPAY_CONVEX_SITE_URL:policy.convexSite,CHAINPAY_ALLOWED_ORIGINS:policy.webOrigins.join(','),[project==='chainpay-relay'?'CHAINPAY_CONVEX_BACKEND_SECRET':'CHAINPAY_CONVEX_MCP_SECRET']:env[project==='chainpay-relay'?'CHAINPAY_CONVEX_BACKEND_SECRET':'CHAINPAY_CONVEX_MCP_SECRET']});
            if(project==='chainpay-mcp')Object.assign(values,{CHAINPAY_APP_URL:policy.webOrigin,CHAINPAY_BACKEND_URL:policy.relayOrigin,CHAINPAY_RPC_URL:`${policy.relayOrigin}/rpc`});
            for(const [key,value] of Object.entries(values))command('vercel',['env','add',key,'production','--force','--yes','--cwd',dir],{input:value});
          } finally { rmSync(dir,{recursive:true,force:true}); }
        }
        save({phase:'switched'});
      } else if(step==='verify' || step==='open') {
        if(!['switched','verified','opening'].includes(state.phase))die('Switch must complete before verifying or opening');
        await integrity();
        if(step==='verify') {
          maintenance();notOpened();
          if(!/^[a-f0-9]{40}$/.test(env.CHAINPAY_RELEASE_SHA??''))die('Set CHAINPAY_RELEASE_SHA to the merged release revision');
          save({releaseSha:env.CHAINPAY_RELEASE_SHA});
          save({phase:'verified',deployments:deployments()});
        } else {
          if(!['verified','opening'].includes(state.phase))die('Run successful deployment verification before opening');
          deployments();
          const previous=convex('env','get',marker);
          if(previous && previous!==state.releaseSha)die('Another release may have opened writes; reconcile before continuing');
          const paused=convex('env','get','CHAINPAY_MAINTENANCE');
          if(paused==='false' && state.phase==='opening' && previous===state.releaseSha) {
            save({phase:'opened',mayHaveOpened:true});log('OK: recovered an opening whose response was lost.');return;
          }
          if(paused!=='true')die('Production Convex must remain in maintenance until opening');
          save({phase:'opening',mayHaveOpened:true});
          convex('env','set',marker,state.releaseSha);
          convex('env','set','CHAINPAY_MAINTENANCE','false');
          save({phase:'opened'});
        }
      } else if(step==='smoke') {
        if(state.phase!=='opened')die('Open must complete before the write-based login smoke test');
        command(process.execPath,['scripts/smoke-vercel.mjs'],{env:{...env,CHAINPAY_APP_URL:policy.webOrigin,CHAINPAY_BACKEND_URL:policy.relayOrigin,CHAINPAY_MCP_URL:policy.mcpOrigin}});
      }
    }
    log(`OK: ${step}. Checkpoint saved; no payment transaction was sent.`);
  } finally { rmdirSync(lock); }
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href)cutover(process.argv[2]).catch(error=>{console.error(`STOP: ${error.message}`);process.exitCode=1;});
