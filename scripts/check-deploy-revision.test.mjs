import test from 'node:test';
import assert from 'node:assert/strict';
import { assertDeployRevision } from './check-deploy-revision.mjs';
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
