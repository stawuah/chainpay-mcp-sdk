// Browser regression fixture: no wallet, signature, backend or settlement calls.
import "../../src/polyfills";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { Mandate } from "@chainpay/sdk";
import "../../skill/assets/design-token.css";
import "../../src/theme/astryx.css";
import "../../src/styles.css";
import { ChainPayTheme } from "../../src/theme/ChainPayTheme";
import { Router } from "../../src/routing/Router";
import { MandatesPanel } from "../../src/dashboard/Dashboard";
import { chainpayClient } from "../../src/config/client";

chainpayClient.connection.getAccountInfo = async () => null;
chainpayClient.getCurrentSlot = async () => 420000000n;
chainpayClient.getMintDecimals = async () => { throw new Error("Metadata unavailable fixture"); };
chainpayClient.connection.getRecentPerformanceSamples = async () => [];
const owner = "11111111111111111111111111111111";
const record: Mandate = { address: "2KW2XRd9kwqet15Aha2oK3tYvd3nWbTFH1MBiRAv1BE1", owner, approvedAgent: owner, sourceTokenAccount: owner, allowedMint: owner,
  maxPerPayment: 100000001n, totalLimit: 500000001n, amountSpent: 120000001n, paymentCount: 3n, expiresAtSlot: 430000000n, maxPaymentCount: 25n, cooldownSlots: 0n, lastPaymentSlot: 419999990n, paused: false, revoked: false, status: "active", tokenProgram: "spl-token" };
const other: Mandate = { ...record, address: "Paused1111111111111111111111111111111111", paused: true, status: "paused" };
const foreign: Mandate = { ...record, address: "Foreign111111111111111111111111111111111", owner: "different-owner" };
function Fixture() {
  const [selected,setSelected]=useState<Mandate|null>(record);
  const [action,setAction]=useState("");
  const [activeOwner,setActiveOwner]=useState(owner);
  const [loadStatus,setLoadStatus]=useState<"ready"|"loading"|"error">("ready");
  return <div className="dashboard-app cp-app"><main className="dashboard-main" style={{minHeight:"150vh"}}><header style={{padding:32}}><h1>Spending permissions</h1><p>Regression fixture. No transactions.</p><output data-testid="action">{action}</output><button onClick={()=>setActiveOwner("different-owner")}>Switch fixture owner</button><button onClick={()=>setLoadStatus("loading")}>Set loading fixture</button><button onClick={()=>setLoadStatus("error")}>Set error fixture</button></header><div style={{padding:"0 24px",maxWidth:1200,margin:"auto"}}><MandatesPanel wallet={activeOwner} loadStatus={loadStatus} mandates={[record,other,foreign]} mandate={selected} mandateDecimals={null}
    stablecoinOptions={[{key:"USDC",label:"USDC",detail:"Fixture",mint:owner,tokenProgram:"spl-token"}]} protocolConfig={null} createOpen={false} onCreateOpenChange={()=>{}}
    onMandateAction={async(kind,value)=>setAction(`${kind}:${value.address}`)} onSelectMandate={setSelected} onOpenPayments={()=>{}} onRefresh={async()=>{}} /></div></main></div>;
}
createRoot(document.getElementById("root")!).render(<ChainPayTheme><Router><Fixture /></Router></ChainPayTheme>);
