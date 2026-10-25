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
    if(service==='backend')assert.ok(existsSync(join(dir,'shared/cards/tee-measurements.json')),'pinned TEE measurements must reach the staged relay');
    if(service==='frontend' && existsSync(join(root,'shared')))assert.ok(existsSync(join(dir,'shared/pet.ts')),'shared source must reach hosted frontend');
  } finally {rmSync(join(root,'.vercel-staging',stamp),{recursive:true,force:true});}
});
// Each Rust upload keeps only its own handler. A [[bin]] or default-run whose
// source is not uploaded makes Cargo reject the manifest and the deploy fails.
for(const [service,handler,other] of [['backend','relay','paypal'],['paypal','paypal','relay']])test(`staged ${service} manifest names only api/${handler}.rs`,()=>{
  const stamp=`test-${randomUUID()}`;
  try {
    const dir=execFileSync(process.execPath,['scripts/stage-vercel.mjs',service],{cwd:root,env:{...process.env,CHAINPAY_RELEASE_ID:stamp},encoding:'utf8'}).trim();
    const manifest=readFileSync(join(dir,'Cargo.toml'),'utf8');
    assert.equal((manifest.match(/^\[\[bin\]\]/gm)??[]).length,1);
    assert.match(manifest,new RegExp(`path = "api/${handler}\\.rs"`));
    assert.doesNotMatch(manifest,/^default-run/m);
    assert.doesNotMatch(manifest,/src\/bin\/paypal\.rs/);
    assert.ok(existsSync(join(dir,`api/${handler}.rs`)));
    assert.ok(!existsSync(join(dir,`api/${other}.rs`)));
  } finally {rmSync(join(root,'.vercel-staging',stamp),{recursive:true,force:true});}
});
test('staged paypal serves the API and the workspace from one origin, apart from Colosseum',()=>{
  const stamp=`test-${randomUUID()}`;
  try {
    const dir=execFileSync(process.execPath,['scripts/stage-vercel.mjs','paypal'],{cwd:root,env:{...process.env,CHAINPAY_RELEASE_ID:stamp},encoding:'utf8'}).trim();
    const config=JSON.parse(readFileSync(join(dir,'vercel.json'),'utf8'));
    const manifest=readFileSync(join(dir,'Cargo.toml'),'utf8');
    assert.match(manifest,/default = \["vercel","paypal"\]/);
    assert.match(config.buildCommand,/build:paypal/);
    assert.doesNotMatch(config.buildCommand,/check-release-env/);
    const to=source=>config.rewrites.find(rule=>rule.source===source)?.destination;
    assert.equal(to('/v1/paypal/:path*'),'/api/paypal');
    assert.equal(to('/healthz'),'/api/paypal');
    assert.equal(to('/paypal/:path*'),'/paypal.html');
    assert.ok(!config.rewrites.some(rule=>rule.destination==='/api/relay'),'never routes to the Colosseum relay');
  } finally {rmSync(join(root,'.vercel-staging',stamp),{recursive:true,force:true});}
});
