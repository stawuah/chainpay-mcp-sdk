import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../src/analytics/privacy.ts',import.meta.url),'utf8');
const {analyticsBeforeSend}=await import(`data:text/javascript;base64,${Buffer.from(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText).toString('base64')}`);
test('page views retain categories but remove identities, queries and fragments',()=>{
  for(const [path,category] of [['/','/'],['/pet','/pet'],['/app/mandates/new','/app/mandates/new'],['/verify/receipt-id','/verify'],['/app/mandates/private-id','/app/mandates'],['/app/receipts/receipt-id','/app/receipts'],['/embed/overview/wallet-id','/embed/overview'],['/app/requests/permission','/app/requests/permission']]) {
    const input={type:'pageview',url:`https://www.chainpayai.app${path}?token=private#req=signed`};
    assert.equal(analyticsBeforeSend(input).url,`https://www.chainpayai.app${category}`);
    assert.ok(input.url.includes('private'),'input must not be mutated');
  }
  assert.equal(analyticsBeforeSend({type:'pageview',url:'https://example.com/unknown/private'}),null);
  assert.equal(analyticsBeforeSend({type:'pageview',url:'invalid'}),null);
  assert.equal(analyticsBeforeSend({type:'event',url:'https://example.com/',name:'private'}),null);
});
