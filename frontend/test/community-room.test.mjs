import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { readFile } from 'node:fs/promises';
async function load(file){const source=await readFile(new URL(file,import.meta.url),'utf8');return import(`data:text/javascript;base64,${Buffer.from(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText).toString('base64')}`);}
const {createScrapbook}=await load('../src/pet/shared/scrapbook.ts');
const {fitPhoto,drawPhotoScene}=await load('../src/pet/shared/photo.ts');
const m=(id,at)=>({id,at,text:id,kind:'first'});
test('cursor pages survive revisions and delayed pages cannot replace newer entries or aggregates',async()=>{
  let fresh=0,finishOld;const paths=[];
  const book=createScrapbook(async path=>{
    paths.push(path);
    if(path.includes('before=50'))return new Promise(resolve=>finishOld=resolve);
    if(path.includes('before=25'))return {memories:[m('oldest',1)],nextBefore:null,aggregates:[]};
    fresh++;
    return {memories:fresh===1?[m('a',100)]:[m('new',120),m('a',100)],nextBefore:fresh===1?50:60,aggregates:[{day:1,counts:{pat:fresh}}]};
  });
  await book.refresh();const more=book.more();await book.refresh();
  finishOld({memories:[m('old',20),m('a',90)],nextBefore:25,aggregates:[{day:1,counts:{pat:0}}]});await more;
  assert.deepEqual(book.get().memories.map(x=>x.id),['new','a','old']);assert.equal(book.get().memories[1].at,100);
  assert.equal(book.get().aggregates[0].counts.pat,2);assert.equal(book.get().nextBefore,25);
  await book.more();await book.refresh();assert.deepEqual(book.get().memories.map(x=>x.id),['new','a','old','oldest']);assert.equal(book.get().nextBefore,null);
  assert.ok(paths.includes('memories?limit=12&before=25'));
});
test('a failed first fetch retries without any world revision change',async()=>{
  let fail=true;const book=createScrapbook(async()=>{if(fail)throw Error('offline');return {memories:[m('found',1)],nextBefore:null,aggregates:[]};});
  await book.refresh();assert.equal(book.get().error,true);fail=false;await book.refresh();assert.equal(book.get().error,false);assert.equal(book.get().memories[0].id,'found');
});
test('photo draws the current source with its aspect ratio and centered letterboxing',()=>{
  assert.deepEqual(fitPhoto(800,400),{x:0,y:50,width:1200,height:600});
  const tall=fitPhoto(390,800);assert.equal(tall.height,700);assert.equal(tall.width/tall.height,390/800);assert.ok(tall.x>0);
  const source={currentFrame:'polished'},calls=[];
  drawPhotoScene({drawImage:(...args)=>calls.push(args)},source,800,400);
  assert.deepEqual(calls,[[source,0,50,1200,600]]);
});
