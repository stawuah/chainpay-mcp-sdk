import test from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { callTool } from "../dist/index.js";
import { requestContext, authorizeTool, parseScope } from "../dist/authorization.js";
import { McpConnectionRegistry } from "../dist/connections.js";

const key = () => Keypair.generate().publicKey.toBase58();
function fixture() {
  const wallet=key(), other=key(), address=key(), agent=key();
  let reads=0;
  return {wallet,other,address,agent,get reads(){return reads;}, context:{principal:{wallet,scope:null},client:{getConfig:async()=>({fixture:true}),getMandate:async()=>{reads++;return {address,owner:wallet,approvedAgent:agent};}}}};
}
test("central dispatch denies missing identity and wrong owner before tool work", async()=>{
  const f=fixture();
  await assert.rejects(callTool({client:f.context.client},"list_mandates",{owner:f.wallet}),/Sign in/);
  await assert.rejects(callTool(f.context,"list_mandates",{owner:f.other}),/Wallet differs/);
  assert.equal(f.reads,0);
});
test("scoped connection permits selected mandate, rejects other mandate, tool, changed agent and revoke",async()=>{
  const f=fixture(), registry=McpConnectionRegistry.inMemory();
  const scope={version:1,mandates:[f.address],tools:["get_mandate"],agents:{[f.address]:f.agent}};
  const registered=await registry.register({wallet:f.wallet,agentName:"Fixture agent",scope:JSON.stringify(scope)});
  const req={headers:{authorization:`Bearer ${registered.token}`}};
  const context=await requestContext(f.context,req,registry);
  await authorizeTool(context,"get_mandate",{address:f.address});
  await assert.rejects(authorizeTool(context,"execute_payment",{mandate:f.address}),/not permitted/);
  await assert.rejects(authorizeTool(context,"get_mandate",{address:key()}),/outside/);
  context.principal.scope.agents[f.address]=key();
  await assert.rejects(authorizeTool(context,"get_mandate",{address:f.address}),/agent changed/);
  context.principal.scope.agents[f.address]=f.agent;
  await registry.revoke(f.wallet,registered.connection.id);
  await assert.rejects(authorizeTool(context,"get_mandate",{address:f.address}),/revoked/);
});
test("legacy Unscoped tokens fail closed with reconnect guidance",()=>{
  assert.throws(()=>parseScope("Unscoped"),/Reconnect/);
});
test("wait_for_payment retains paymentId contract",async()=>{
  const f=fixture();
  await authorizeTool(f.context,"wait_for_payment",{paymentId:"fixture-payment"});
});
test("on-chain wrong owner blocks mandate access",async()=>{
  const f=fixture();f.context.principal.wallet=f.other;
  await assert.rejects(authorizeTool(f.context,"get_mandate",{address:f.address}),/not owned/);
});

test("HTTP owner routes derive identity and reject other wallets before inbox or chat work", async(t)=>{
  const {createServer}=await import("node:http");
  const {createHttpServer}=await import("../dist/http.js");
  const f=fixture();
  const token="a".repeat(64);
  const backend=createServer((req,res)=>{
    res.setHeader("Content-Type","application/json");
    if(req.headers.authorization!==`Bearer ${token}`){res.writeHead(401);res.end('{}');return;}
    res.end(JSON.stringify({wallet:f.wallet,expires_at_ms:Date.now()+60000}));
  });
  await new Promise(resolve=>backend.listen(0,"127.0.0.1",resolve));
  const registry=McpConnectionRegistry.inMemory();
  await registry.appendInboxMessage(f.wallet,"user",{message:"Owner-only fixture"});
  const {server}=createHttpServer({...f.context,principal:undefined,backendUrl:`http://127.0.0.1:${backend.address().port}`},{host:"127.0.0.1",port:3000,allowedOrigins:["http://localhost:5173"]},registry);
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  t.after(()=>{server.closeAllConnections();server.close();backend.closeAllConnections();backend.close();});
  const base=`http://127.0.0.1:${server.address().port}`;
  const headers={Authorization:`Bearer ${token}`,"Content-Type":"application/json"};
  assert.equal((await fetch(`${base}/inbox?wallet=${f.wallet}`)).status,401);
  assert.equal((await fetch(`${base}/inbox?wallet=${f.other}`,{headers})).status,403);
  const own=await fetch(`${base}/inbox`,{headers});
  assert.equal(own.status,200);assert.equal((await own.json()).messages.length,1);
  assert.equal((await fetch(`${base}/connections`,{method:"POST",headers,body:JSON.stringify({wallet:f.other,agentName:"Denied",scope:"Unscoped"})})).status,403);
  assert.equal((await fetch(`${base}/agent/chat`,{method:"POST",headers,body:JSON.stringify({wallet:f.other,message:"Never send to a model"})})).status,403);
  const rpc = async (name, args) => (await fetch(`${base}/mcp`, {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({jsonrpc:"2.0", id:1, method:"tools/call", params:{name, arguments:args}})})).json();
  const publicResult = await rpc("get_protocol_config", {});
  assert.equal(publicResult.result.isError, undefined);
  assert.match(JSON.stringify(publicResult.result), /fixture/);
  const privateResult = await rpc("list_mandates", {owner:f.wallet});
  assert.match(privateResult.error.message, /Sign in/);
  assert.equal((await registry.list(f.other)).length,0);
  assert.equal((await registry.listInbox(f.other)).length,0);
});

test("hosted x402 rejects non-allowlisted resource origins before fetching",async()=>{
  const {executeX402Payment}=await import("../dist/tools/x402.js");
  const original=process.env.CHAINPAY_X402_ALLOWED_ORIGINS;
  process.env.CHAINPAY_X402_ALLOWED_ORIGINS="https://merchant.example.com";
  try {await assert.rejects(executeX402Payment({client:{}},{resource:"https://127.0.0.1/private"}),/not in CHAINPAY_X402_ALLOWED_ORIGINS/);}
  finally {if(original===undefined)delete process.env.CHAINPAY_X402_ALLOWED_ORIGINS;else process.env.CHAINPAY_X402_ALLOWED_ORIGINS=original;}
});
