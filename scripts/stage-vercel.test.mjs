import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,existsSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
const root=resolve(import.meta.dirname,'..');
for(const service of ['backend','mcp','frontend'])test(`staged ${service} rejects invalid release settings before building`,()=>{
  const stamp=`test-${randomUUID()}`;
  try {
    const dir=execFileSync(process.execPath,['scripts/stage-vercel.mjs',service],{cwd:root,env:{...process.env,CHAINPAY_RELEASE_ID:stamp},encoding:'utf8'}).trim();
    const config=JSON.parse(readFileSync(join(dir,'vercel.json'),'utf8'));
    assert.match(config.buildCommand,/^node scripts\/check-release-env.mjs /);
    assert.throws(()=>execFileSync('/bin/sh',['-c',config.buildCommand],{cwd:dir,env:{PATH:process.env.PATH},stdio:'pipe'}),error=>{assert.match(error.stderr.toString(),/CHAINPAY_RELEASE_ENVIRONMENT is required/);return true;});
    if(service==='frontend' && existsSync(join(root,'shared')))assert.ok(existsSync(join(dir,'shared/pet.ts')),'shared source must reach hosted frontend');
  } finally {rmSync(join(root,'.vercel-staging',stamp),{recursive:true,force:true});}
});
