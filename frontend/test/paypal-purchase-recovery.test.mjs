// Shared PayPal purchase and allowance recovery tests, independent of dashboard integration.
import test from "node:test";
import assert from "node:assert/strict";
import { unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createElement, act } from "react";
import { JSDOM } from "jsdom";

const frontendRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(frontendRoot, "package.json"));
const esbuild = require("esbuild");

const dom = new JSDOM("<!doctype html><html data-astryx-theme><body></body></html>", { url: "https://chainpay.example/app/paypal", pretendToBeVisual: true });
for (const key of ["window", "document", "HTMLElement", "Node", "Element", "MutationObserver", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "history", "location", "HTMLInputElement", "Event", "KeyboardEvent", "MouseEvent", "PopStateEvent", "CustomEvent", "matchMedia", "ResizeObserver", "DOMRect", "localStorage", "sessionStorage", "Storage"]) {
  if (dom.window[key] !== undefined && globalThis[key] === undefined) globalThis[key] = typeof dom.window[key] === "function" && !/^[A-Z]/.test(key) ? dom.window[key].bind(dom.window) : dom.window[key];
}
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
dom.window.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
globalThis.matchMedia = dom.window.matchMedia;
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
dom.window.ResizeObserver = globalThis.ResizeObserver;
globalThis.CSS ??= { supports: () => false, escape: (value) => value };
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");

const outfile=join(frontendRoot, 'test/.tmp-paypal-recovery.mjs');
await esbuild.build({
 absWorkingDir:frontendRoot,
 stdin:{contents:'export {default as Marketplace} from "./src/paypal/Marketplace"; export {default as Allowances} from "./src/paypal/Allowances"; export {PayPalRequestUncertainError} from "./src/paypal/client";',resolveDir:frontendRoot,loader:'ts'},
 bundle:true,format:'esm',platform:'browser',jsx:'automatic',outfile,
 loader:{'.css':'empty','.svg':'empty','.png':'empty','.webp':'empty'},
 external:['react','react-dom','react/jsx-runtime','react-dom/client'],
 define:{'import.meta.env':'{}'},logLevel:'error',
});
const on=await import(pathToFileURL(outfile).href);
await unlink(outfile);

async function render(element) {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () => { root.render(element); });
  return { host, rerender: (next) => act(async () => { root.render(next); }), unmount: async () => { await act(async () => root.unmount()); host.remove(); } };
}
const settle = (ms = 30) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const button = (host, name) => [...host.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") || b.textContent).trim() === name);

function marketFixture(quoteResponse, purchaseResponse=async()=>({id:'task',purchase:{}})) {
 const allowance={id:'allowance',name:'Test allowance',status:'Active',mode:'agent_pays',remaining_cents:5000,total_cap_cents:5000,per_purchase_cap_cents:5000};
 const merchant={id:'grocer',name:'Corner Grocer',kind:'groceries',items:[{id:'milk',name:'Milk',price_cents:400,price:'4.00',availability:'available'}]};
 const quotes=[];const purchases=[];
 const api=async(path,method,body)=>{
  if(path==='/catalog')return {merchants:[merchant]};
  if(path==='/allowances')return {allowances:[allowance]};
  if(path==='/purchases/quote'){quotes.push(body);return quoteResponse(body);}
  if(path==='/purchases'){purchases.push(body);return purchaseResponse(body);}
  throw new Error('Unexpected route '+path);
 };
 return {api,quotes,purchases};
}
const pricedQuote={merchant:'grocer',lines:[{id:'milk',name:'Milk',qty:1,unit_cents:400,line_cents:400}],amount_cents:400,amount:'4.00',currency:'USD',sandbox:true,policy:{allowed:true}};
async function clickButton(host,label){const b=button(host,label);assert.ok(b,`Missing ${label}`);await act(async()=>{b.dispatchEvent(new window.MouseEvent('click',{bubbles:true}));});}

test('removing the last item invalidates any pending quote before it can enable purchase',async()=>{
 let resolve;const pending=new Promise(r=>{resolve=r;});
 const f=marketFixture(()=>pending);
 const r=await render(createElement(on.Marketplace,{api:f.api,principal:{role:'buyer'},onPurchased(){}}));
 try{
  await settle();await act(async()=>{r.host.querySelector('.paypal-merchant-tile').click();});
  await clickButton(r.host,'More Milk');assert.equal(f.quotes.length,1);
  await clickButton(r.host,'Fewer Milk');
  await act(async()=>{resolve(pricedQuote);await pending;});
  assert.equal(r.host.querySelector('.paypal-quote'),null);
  assert.equal(button(r.host,'Buy now').disabled,true);assert.equal(f.purchases.length,0);
 }finally{await r.unmount();}
});

test('uncertain purchase freezes its basket and retries the identical original request',async()=>{
 let fail=true;const received=[];
 const f=marketFixture(async()=>pricedQuote,async()=>{if(fail===true)throw new on.PayPalRequestUncertainError('No response yet');if(fail==='rejected')throw new Error('Session expired');return {id:'original-task',purchase:{}};});
 const r=await render(createElement(on.Marketplace,{api:f.api,principal:{role:'buyer'},onPurchased:x=>received.push(x)}));
 try{
  await settle();await act(async()=>{r.host.querySelector('.paypal-merchant-tile').click();});
  await clickButton(r.host,'More Milk');await settle();
  await clickButton(r.host,'Buy now · $4.00');
  assert.match(r.host.textContent,/outcome is unknown/);
  const unload=new window.Event('beforeunload',{cancelable:true});window.dispatchEvent(unload);assert.equal(unload.defaultPrevented,true);
  assert.equal(button(r.host,'More Milk').disabled,true);assert.equal(button(r.host,'Fewer Milk').disabled,true);
  assert.equal(r.host.querySelector('select').disabled,true);
  fail='rejected';await clickButton(r.host,'Retry original purchase');
  assert.equal(button(r.host,'More Milk').disabled,true);assert.equal(r.host.querySelector('select').disabled,true);
  fail=false;await clickButton(r.host,'Retry original purchase');
  assert.equal(f.purchases.length,3);assert.deepEqual(f.purchases[1],f.purchases[0]);assert.deepEqual(f.purchases[2],f.purchases[0]);
  assert.equal(received[0].id,'original-task');
 }finally{await r.unmount();}
});


test('buyer without allowances has an actionable recovery; agents ask their buyer', async()=>{
 const f=marketFixture(async()=>pricedQuote);const original=f.api;
 const api=(path,...rest)=>path==='/allowances'?Promise.resolve({allowances:[]}):original(path,...rest);
 let opened=0;
 const r=await render(createElement(on.Marketplace,{api,principal:{role:'buyer'},onPurchased(){},onOpenAllowances(){opened++;}}));
 try { await settle(); await clickButton(r.host,'Open allowances');assert.equal(opened,1);
 await r.rerender(createElement(on.Marketplace,{api,principal:{role:'agent'},onPurchased(){}}));await settle();
 assert.match(r.host.textContent,/Ask the buyer to create or resume/);assert.equal(button(r.host,'Open allowances'),undefined);
 }finally{await r.unmount();}
});

test('unknown allowance creation locks fields and retries the same authority exactly once', async()=>{
 const calls=[];let fail=true;
 const api=async(path,method,body)=>{
  if(path==='/allowances'&&method==='POST') { calls.push(JSON.parse(JSON.stringify(body)));if(fail===true)throw new on.PayPalRequestUncertainError('No response yet');if(fail==='rejected')throw new Error('Session expired');return {id:'original-allowance'}; }
  if(path==='/allowances')return {allowances:[]};
  if(path==='/catalog')return {merchants:[{id:'grocer',name:'Corner Grocer',kind:'grocery',items:[]}]};
  if(path==='/purchases/approvals')return {approvals:[]};
  throw new Error('Unexpected route '+path);
 };
 const r=await render(createElement(on.Allowances,{api,principal:{id:'buyer',workspace:'test',role:'buyer'},onReceipt(){}}));
 try{
  await settle();await clickButton(r.host,'Create allowance');
  assert.match(r.host.textContent,/creation outcome is unknown/);
  const unload=new window.Event('beforeunload',{cancelable:true});window.dispatchEvent(unload);assert.equal(unload.defaultPrevented,true);
  const form=r.host.querySelector('form');assert.ok([...form.querySelectorAll('input')].every(input=>input.disabled));
  fail='rejected';await clickButton(r.host,'Retry original allowance');
  assert.ok([...form.querySelectorAll('input')].every(input=>input.disabled));
  fail=false;await clickButton(r.host,'Retry original allowance');
  assert.equal(calls.length,3);assert.deepEqual(calls[1],calls[0]);assert.deepEqual(calls[2],calls[0]);
  assert.ok([...form.querySelectorAll('input')].every(input=>!input.disabled));
 }finally{await r.unmount();}
});
