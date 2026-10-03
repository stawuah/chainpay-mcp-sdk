import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,readFileSync,writeFileSync,rmSync,existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { cutover,validateTarget } from './cutover-vercel-convex.mjs';
import { TABLES,rowDigest } from './migrate-storage.mjs';
const sha='a'.repeat(40);
function snapshot(file,filled=false) {
  const row='{"payment_id":"p","amount":18446744073709551615}';
  const tables=Object.fromEntries(Object.keys(TABLES).map(table=>{
    const entries=filled && table==='payments' ? [['["p"]',rowDigest(row)]]:[];
    return [table,{count:entries.length,sha256:createHash('sha256').update(JSON.stringify(entries)).digest('hex')}];
  }));
  writeFileSync(file,[{type:'header',version:1,source:'fixture'},...(filled?[{type:'row',table:'payments',row}]:[]),{type:'manifest',tables}].map(x=>JSON.stringify(x)).join('\n')+'\n');
  return tables;
}
function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'chainpay-cutover-test-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const env={CHAINPAY_CUTOVER_DIR:dir,CONVEX_DEPLOY_KEY:'prod:notable-bee-447|test-only',CHAINPAY_CONVEX_SITE_URL:'https://notable-bee-447.convex.site',CHAINPAY_CONVEX_BACKEND_SECRET:'b'.repeat(32),CHAINPAY_CONVEX_MCP_SECRET:'m'.repeat(32),CHAINPAY_CONVEX_MIGRATION_SECRET:'i'.repeat(32),CHAINPAY_SOURCE_DATABASE_URL:'fixture',CHAINPAY_RELEASE_SHA:sha};
  const settings={...env,CHAINPAY_MAINTENANCE:'true'};
  const calls=[],logs=[];let imported=false;
  const f={env,settings,calls,logs,dir,failImport:false,failCompare:false,failEnv:false,wrongDeployment:false,failWorkflow:false,nonempty:false,sourceExports:0};
  const run=(cmd,args,options)=>{
    calls.push({cmd,args,options});
    if(cmd==='npx') {
      const [, , ,op,key,value]=args;
      if(op==='get')return settings[key]??'';
      if(op==='set'){settings[key]=value;if(key==='CHAINPAY_MAINTENANCE'&&value==='false'&&f.loseOpen){f.loseOpen=false;throw Error('lost opening response');}return '';}
      if(op==='remove'){delete settings[key];return '';}
    }
    if(args[0]==='scripts/migrate-storage.mjs') {
      const [,op,file]=args;
      if(op==='export-postgres'){f.sourceExports++;return JSON.stringify(snapshot(file,true));}
      if(op==='export-convex')return JSON.stringify(snapshot(file,imported||f.nonempty));
      if(op==='import-convex'){if(args.includes('--apply')){imported=true;if(f.failImport){f.failImport=false;throw Error('lost response');}}return '{}';}
      if(op==='compare')return JSON.stringify({equal:!f.failCompare});
    }
    if(cmd==='vercel') {
      if(args[0]==='env' && f.failEnv){f.failEnv=false;throw Error('env interrupted');}
      if(args[0]==='inspect') {
        const name=args[1].includes('relay')?'relay':args[1].includes('mcp')?'mcp':'web';
        return JSON.stringify({id:`dpl_${name}`});
      }
      if(args[0]==='api') {
        const name=args[1].split('dpl_')[1];
        return JSON.stringify({id:`dpl_${name}`,name:`chainpay-${name}`,readyState:'READY',target:'production',meta:{githubCommitSha:f.wrongDeployment?'b'.repeat(40):sha}});
      }
      return '';
    }
    if(cmd==='gh')return JSON.stringify({workflow_runs:[{id:1,head_sha:sha,head_branch:'master',head_repository:{full_name:'stawuah/chainpay-mcp-sdk'},status:'completed',conclusion:f.failWorkflow?'failure':'success'}]});
    if(args[0]==='scripts/smoke-vercel.mjs')return '';
    throw Error(`Unexpected test command ${cmd} ${args}`);
  };
  f.step=step=>cutover(step,{env,run,confirm:async()=> 'PAUSED',log:line=>logs.push(line)});
  f.state=()=>JSON.parse(readFileSync(join(dir,'state.json'),'utf8'));
  return f;
}
test('target validation rejects development or mixed credentials',()=>{
  assert.throws(()=>validateTarget({}),/production deploy key/);
});
test('files from failed preflight cannot authorize migration',async t=>{
  const f=fixture(t);f.nonempty=true;
  await assert.rejects(f.step('preflight'),/not empty/);
  assert.ok(existsSync(join(f.dir,'prod-before.ndjson')));
  await assert.rejects(f.step('migrate'),/successful preflight/);
});
test('interrupted import resumes the same immutable source without re-export',async t=>{
  const f=fixture(t);await f.step('preflight');f.failImport=true;
  await assert.rejects(f.step('migrate'),/lost response/);
  assert.equal(f.state().phase,'preflight');
  await f.step('migrate');assert.equal(f.sourceExports,1);assert.equal(f.state().phase,'migrated');
});
test('failed comparison and modified snapshots block switching',async t=>{
  const f=fixture(t);await f.step('preflight');f.failCompare=true;
  await assert.rejects(f.step('migrate'),/comparison failed/);
  await assert.rejects(f.step('switch'),/successful migration/);
  f.failCompare=false;await f.step('migrate');
  writeFileSync(join(f.dir,'roundtrip.ndjson'),'partial');
  await assert.rejects(f.step('switch'));
  assert.equal(f.calls.filter(c=>c.cmd==='vercel').length,0);
});
test('partial switch retries and opening requires current verified deployment',async t=>{
  const f=fixture(t);await f.step('preflight');await f.step('migrate');
  f.failEnv=true;await assert.rejects(f.step('switch'),/env interrupted/);
  assert.equal(f.state().phase,'migrated');await f.step('switch');
  await assert.rejects(f.step('open'),/successful deployment verification/);
  f.failWorkflow=true;await assert.rejects(f.step('verify'),/workflow/);f.failWorkflow=false;
  f.wrongDeployment=true;await assert.rejects(f.step('verify'),/alias/);f.wrongDeployment=false;
  await f.step('verify');f.wrongDeployment=true;await assert.rejects(f.step('open'),/alias/);f.wrongDeployment=false;
  await f.step('open');assert.equal(f.settings.CHAINPAY_MAINTENANCE,'false');assert.equal(f.settings.CHAINPAY_CUTOVER_WRITES_OPENED,sha);
  const marker=f.calls.findIndex(c=>c.args.includes('CHAINPAY_CUTOVER_WRITES_OPENED')&&c.args.includes('set'));
  const opening=f.calls.findIndex(c=>c.args.includes('CHAINPAY_MAINTENANCE')&&c.args.includes('false'));
  assert.ok(marker<opening);
  await assert.rejects(f.step('abort'),/fresh Convex/);assert.equal(f.settings.CHAINPAY_MAINTENANCE,'true');
  assert.ok(!f.logs.some(line=>line.includes('may resume Render')));
});
test('remote write marker prevents unsafe abort even without local checkpoint',async t=>{
  const f=fixture(t);f.settings.CHAINPAY_CUTOVER_WRITES_OPENED=sha;
  await assert.rejects(f.step('abort'),/fresh Convex/);
});
test('safe abort closes migration and prevents reuse of stale attempt',async t=>{
  const f=fixture(t);await f.step('preflight');await f.step('abort');
  assert.equal(f.settings.CHAINPAY_MAINTENANCE,'true');assert.equal(f.settings.CHAINPAY_CONVEX_MIGRATION_ENABLED,undefined);
  await assert.rejects(f.step('migrate'),/aborted/);
});
test('a lost opening response reconciles remote state without reverting data',async t=>{
  const f=fixture(t);for(const step of ['preflight','migrate','switch','verify'])await f.step(step);
  f.loseOpen=true;await assert.rejects(f.step('open'),/lost opening response/);
  assert.equal(f.state().phase,'opening');assert.equal(f.settings.CHAINPAY_MAINTENANCE,'false');
  await f.step('open');assert.equal(f.state().phase,'opened');
  f.env.CHAINPAY_BACKEND_URL='https://stale.invalid';await f.step('smoke');
  assert.equal(f.calls.at(-1).options.env.CHAINPAY_BACKEND_URL,'https://chainpay-relay.vercel.app');
});
test('abort pauses remote writes even with incompatible or corrupt checkpoints',async t=>{
  const f=fixture(t);await f.step('preflight');
  writeFileSync(join(f.dir,'state.json'),JSON.stringify({...f.state(),scriptHash:'changed'}));
  await f.step('abort');assert.equal(f.settings.CHAINPAY_MAINTENANCE,'true');
  writeFileSync(join(f.dir,'state.json'),'partial');f.settings.CHAINPAY_MAINTENANCE='false';
  await assert.rejects(f.step('abort'),/fresh Convex/);assert.equal(f.settings.CHAINPAY_MAINTENANCE,'true');
  assert.equal(existsSync(join(f.dir,'.lock')),false);
});
