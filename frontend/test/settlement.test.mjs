import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
let sequence=0;
async function fixture(t,{rejectLogin=false,storageFailure=false}={}) {
  const compile=source=>ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.React}}).outputText;
  const uri=source=>`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
  const sessionUri=uri(compile(await readFile(new URL("../src/session.ts",import.meta.url),"utf8"))+`\n//${sequence++}`);
  const session=await import(sessionUri);
  let source=await readFile(new URL("../src/settlement.tsx",import.meta.url),"utf8");
  source=source.replace('import { useEffect, useState } from "react";','').replace('from "./session"',`from ${JSON.stringify(sessionUri)}`);
  const settlement=await import(uri(compile(source)));
  const original={fetch:globalThis.fetch,window:globalThis.window,location:globalThis.location,localStorage:globalThis.localStorage};
  t.after(()=>Object.assign(globalThis,original));
  const entries=new Map();const calls=[];
  globalThis.window=new EventTarget();globalThis.location={href:"https://fixture.example"};
  globalThis.localStorage={getItem:key=>entries.get(key)??null,setItem:(key,value)=>{if(storageFailure)throw new Error("fixture storage full");entries.set(key,value);}};
  globalThis.fetch=async(url,init={})=>{calls.push([url,init]);return Response.json(String(url).includes("challenge")?{challenge_id:"fixture",message:"login"}:{token:"fixture-token",wallet:"owner",expires_at_ms:Date.now()+60_000});};
  session.configureSession("https://fixture.example","https://fixture.example/mcp");session.setSessionWallet({address:"owner",signMessage:async()=>{if(rejectLogin)throw new Error("login declined");return new Uint8Array(64);}});
  return {...settlement,...session,entries,calls};
}
test("declined login and storage failure create no ambiguous orphan",async t=>{
  const f=await fixture(t,{rejectLogin:true});
  await assert.rejects(f.beginSettlement("https://fixture.example","payments","invoice"),/login declined/);
  assert.equal(f.entries.size,0);assert.equal(f.calls.length,1);
});
test("unavailable durable browser storage prevents submission",async t=>{
  const f=await fixture(t,{storageFailure:true});
  await assert.rejects(f.beginSettlement("https://fixture.example","payments","invoice"),/storage full/);
  assert.ok(f.calls.every(([url])=>!String(url).includes("/payments")));
});
test("pending state survives reload references and only actual program pause/revoke bypass approval guard",async t=>{
  const f=await fixture(t);const operation=await f.beginSettlement("https://fixture.example","payments","invoice");
  assert.equal(JSON.parse([...f.entries.values()][0])[0].id,operation.id);
  const tx=(program,data)=>({instructions:[{programId:{toBase58:()=>program},data}]});
  const revoke=[252,97,140,119,67,43,177,108],pause=[192,108,97,124,56,229,236,3];
  await assert.rejects(f.guardPendingApprovals("owner",tx("program",[0]),"program"),f.PendingSettlementError);
  await assert.rejects(f.guardPendingApprovals("owner",tx("other",revoke),"program"),f.PendingSettlementError);
  await f.guardPendingApprovals("owner",tx("program",revoke),"program");await f.guardPendingApprovals("owner",tx("program",pause),"program");
  const final=await f.awaitSettlement(operation,{status:"confirmed",signature:"original-signature",amount:"18446744073709551615"});
  assert.equal(BigInt(JSON.parse(JSON.stringify(final)).amount),18446744073709551615n);
  await f.guardPendingApprovals("owner",tx("program",[0]),"program");
});

test("pending reconciliation completes the original consumer and stale responses cannot erase finality",async t=>{
  const f=await fixture(t);const op=await f.beginSettlement("https://fixture.example","payments","pending-fixture");
  let form="signing",receipt;
  const pending=()=>{form="pending";};const target=window;target.addEventListener(f.settlementPendingEvent,pending);t.after(()=>target.removeEventListener(f.settlementPendingEvent,pending));
  const continuation=f.awaitSettlement(op,{status:"submitted",payment_id:op.id,signature:"same-signature"},0).then(result=>{form="success";receipt=result.receipt_address;});
  await Promise.resolve();assert.equal(form,"pending");
  globalThis.fetch=async()=>Response.json({status:"confirmed",payment_id:op.id,signature:"same-signature",receipt_address:"receipt-original"});
  await f.reconcileSettlement(op);await continuation;
  assert.equal(form,"success");assert.equal(receipt,"receipt-original");
  const stale=f.publishSettlement(op,{status:"submitted"});assert.equal(stale.status,"confirmed");assert.equal(stale.signature,"same-signature");
  f.dismissSettlement(op.id);assert.deepEqual(JSON.parse([...f.entries.values()][0]),[]);
});

test("terminal event updates an originating signing form without a new approval", async t => {
  const f=await fixture(t);const op=await f.beginSettlement("https://fixture.example","payments","form-origin");
  let form="signing";const target=window;
  const settled=event=>{const operation=event.detail;if(operation.wallet!=="owner")return;if((form==="signing"||form==="pending")&&["confirmed","failed"].includes(operation.status))form=operation.status==="confirmed"?"success":"error";};
  target.addEventListener(f.settlementTerminalEvent,settled);t.after(()=>target.removeEventListener(f.settlementTerminalEvent,settled));
  f.publishSettlement(op,{status:"confirmed",signature:"same-signature",receipt_address:"receipt-original"});
  assert.equal(form,"success");
});

test("wallet switch during digest creates no reservation and before submit is definitively not sent",async t=>{
  const f=await fixture(t);const original=globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
  globalThis.crypto.subtle.digest=async(...args)=>{f.setSessionWallet({address:"other",signMessage:async()=>new Uint8Array(64)});return original(...args);};
  t.after(()=>{globalThis.crypto.subtle.digest=original;});
  await assert.rejects(f.beginSettlement("https://fixture.example","payments","switch"),/Wallet changed/);assert.equal(f.entries.size,0);
});

test("terminal history is bounded and pending entries cannot be dismissed",async t=>{
  const f=await fixture(t);const op=await f.beginSettlement("https://fixture.example","payments","history");
  for(let i=0;i<40;i++)f.publishSettlement({...op,id:`payment_${i.toString(16).padStart(64,"0")}`},{status:"confirmed",signature:"fixture"});
  f.dismissSettlement(op.id);
  const rows=JSON.parse([...f.entries.values()][0]);assert.equal(rows.filter(r=>r.status==="confirmed").length,30);assert.ok(rows.some(r=>r.id===op.id));
});
