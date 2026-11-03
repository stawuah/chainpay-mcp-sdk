import test from 'node:test';
import assert from 'node:assert/strict';
import { assertDeployRevision, revisionPending } from './check-deploy-revision.mjs';
const repository='stawuah/chainpay-mcp-sdk', sha='a'.repeat(40);
const passed={id:1,head_sha:sha,head_branch:'master',event:'push',head_repository:{full_name:repository},status:'completed',conclusion:'success'};
const verify=runs=>assertDeployRevision({repository,sha,tip:sha,runs});
test('automatic and manual releases require green checks at the exact master tip',()=>{
  assert.doesNotThrow(()=>verify([passed]));
  assert.throws(()=>assertDeployRevision({repository,sha,tip:'b'.repeat(40),runs:[passed]}),/master tip/);
  for(const change of [{head_sha:'b'.repeat(40)},{event:'pull_request'},{head_branch:'other'},{head_repository:{full_name:'fork/repo'}},{status:'in_progress'},{conclusion:'failure'}]) assert.throws(()=>verify([{...passed,...change}]),/must succeed/);
  assert.throws(()=>verify([]),/must succeed/);
  assert.throws(()=>verify([passed,{...passed,id:2,status:'in_progress',conclusion:null}]),/must succeed/);
});
test('only a run the API has not shown as completed is worth waiting for',()=>{
  const pending=runs=>revisionPending({repository,sha,runs});
  assert.equal(pending([]),true);
  assert.equal(pending([{...passed,status:'in_progress',conclusion:null}]),true);
  assert.equal(pending([passed,{...passed,id:2,status:'queued',conclusion:null}]),true);
  assert.equal(pending([passed]),false);
  assert.equal(pending([{...passed,conclusion:'failure'}]),false);
  assert.equal(pending([{...passed,conclusion:'cancelled'}]),false);
});

test('PayPal deployment checks query the PayPal workflow and reject its failed run', async () => {
  const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const dir = await mkdtemp(join(tmpdir(), 'paypal-deploy-check-'));
  try {
    const log = join(dir, 'calls');
    await writeFile(join(dir, 'gh'), `#!${process.execPath}\nconst fs=require('node:fs'); const p=process.argv[3]; fs.appendFileSync(process.env.CALL_LOG,p+'\\n'); console.log(JSON.stringify(p.includes('/commits/')?{sha:process.env.SHA}:{workflow_runs:[{id:1,head_sha:process.env.SHA,head_branch:'master',event:'push',head_repository:{full_name:process.env.GITHUB_REPOSITORY},status:'completed',conclusion:process.env.CHECK_RESULT}]}));\n`, {mode:0o755});
    for (const conclusion of ['success','failure']) {
      const result = spawnSync(process.execPath, ['scripts/check-deploy-revision.mjs'], {encoding:'utf8', env:{...process.env, PATH:`${dir}:${process.env.PATH}`, GITHUB_REPOSITORY:repository, SHA:sha, CHECK_WORKFLOW:'paypal-checks.yml', CHECK_RESULT:conclusion, CALL_LOG:log}});
      assert.equal(result.status, conclusion==='success'?0:1, result.stderr);
    }
    const calls = await readFile(log,'utf8');
    assert.match(calls, /workflows\/paypal-checks.yml\/runs/);
    assert.doesNotMatch(calls, /release-checks.yml/);
    assert.ok(calls.indexOf('/runs?') < calls.indexOf('/commits/master'), 're-read current master after waiting for checks');
  } finally { await rm(dir,{recursive:true,force:true}); }
});
