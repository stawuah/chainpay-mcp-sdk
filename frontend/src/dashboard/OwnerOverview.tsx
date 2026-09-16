import { TokenIcon } from "../ui/TokenIcon";
import { useEffect, useState } from "react";
import type { Mandate } from "@chainpay/sdk";
import { ArrowRight, Bot, CheckCheck, Clock3, Inbox, ShieldCheck } from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { chainpayClient, connectionSeenLabel, mandateDisplayName, type AgentConnection, type AgentInboxItem, type StablecoinOption } from "../owner/runtime";
import { connectionIsLive } from "../owner/purchaseCard";
import { formatTokenAmount } from "../owner/amounts";
import type { RecentActivityRow } from "../owner/recentActivity";
import { shortAddress } from "../ui/marks";
import { publicReceiptPath } from "../receipts/model";
import { useSlotEstimate } from "../owner/useSlotEstimate";
import { estimatedSlotsForDays } from "../owner/slotEstimate";
import { SpendMeter } from "./charts/SpendMeter";

export function OwnerOverview({ mandates, connections, connectionError, attention, activity, assets, onRequests, onAgents, onPermissions, onPermission, onPayments }: {
  mandates: Mandate[]; connections: AgentConnection[]; connectionError: boolean; attention: AgentInboxItem[]; activity: RecentActivityRow[]; assets: StablecoinOption[];
  onRequests: () => void; onAgents: () => void; onPermissions: () => void; onPermission: (address: string) => void; onPayments: () => void;
}) {
  const [decimals, setDecimals] = useState<Record<string, number>>({});
  const [slot, setSlot] = useState<bigint | null>(null);
  const { estimate } = useSlotEstimate();
  const mintKey = [...new Set(mandates.map((m) => m.allowedMint))].sort().join(",");
  useEffect(() => {
    let active = true;
    setDecimals({});
    void Promise.all(mintKey.split(",").filter(Boolean).map(async (mint) => {
      try { return [mint, await chainpayClient.getMintDecimals(mint)] as const; } catch { return null; }
    })).then((rows) => { if (active) setDecimals(Object.fromEntries(rows.filter((row) => row !== null))); });
    void chainpayClient.getCurrentSlot().then((value) => { if (active) setSlot(value); }).catch(() => {});
    return () => { active = false; };
  }, [mintKey]);
  const totals = [...new Set(mandates.map((m) => m.allowedMint))].map((mint) => {
    const matching = mandates.filter((m) => m.allowedMint === mint);
    return { mint, spent: matching.reduce((sum, m) => sum + m.amountSpent, 0n), remaining: matching.filter((m) => m.status === "active").reduce((sum, m) => sum + (m.totalLimit > m.amountSpent ? m.totalLimit - m.amountSpent : 0n), 0n) };
  });
  const soon = estimate ? estimatedSlotsForDays(1, estimate) : null;
  const expiring = mandates.filter((m) => m.status === "active" && slot !== null && soon !== null && m.expiresAtSlot > slot && m.expiresAtSlot - slot <= soon);
  const symbol = (mint: string) => assets.find((a) => a.mint === mint)?.label ?? shortAddress(mint);
  const count = attention.length + expiring.length;
  return <div className="owner-overview">
    <section className="dashboard-card owner-attention"><div className="dashboard-card-heading"><h2>{count ? "Needs your attention" : "You’re up to date"}</h2>{count ? <span className="chip">{count} {count === 1 ? "item" : "items"}</span> : <CheckCheck className="owner-positive" />}</div>
      {count === 0 && <p className="owner-muted">No requests in this browser are waiting for action.</p>}
      {attention.slice(0, 5).map((item) => <button className="owner-attention-row" key={item.id} onClick={onRequests}><span className="owner-row-icon"><Inbox /></span><span><strong>{item.title || "Payment request"}</strong><small>{item.stage === "waiting_for_approval" ? "Ready for your review" : item.stage === "blocked" ? "Needs attention before it can continue" : "More details needed"}</small></span><span className="owner-row-action">Review <ArrowRight /></span></button>)}
      {attention.length > 5 && <Button label={`View all ${attention.length} requests`} variant="ghost" onClick={onRequests} />}
      {expiring.map((m) => <button className="owner-attention-row" key={m.address} onClick={() => onPermission(m.address)}><span className="owner-row-icon neutral"><Clock3 /></span><span><strong>{mandateDisplayName(m, mandates, assets)}</strong><small>Expires within about a day · estimated</small></span><span className="owner-row-action">Review <ArrowRight /></span></button>)}
    </section>
    <section className="dashboard-card owner-spending"><div className="dashboard-card-heading"><h2>Spending overview</h2><Button label="Manage permissions" variant="ghost" onClick={onPermissions} /></div><div className="owner-token-totals">{totals.map((total) => <div key={total.mint}><div className="owner-token-heading"><TokenIcon mint={total.mint} /><span>{symbol(total.mint)} spent</span></div><strong>{formatTokenAmount(total.spent, decimals[total.mint] ?? null)} <small>{symbol(total.mint)}</small></strong><p>{formatTokenAmount(total.remaining, decimals[total.mint] ?? null)} {symbol(total.mint)} active allowance remaining</p></div>)}</div><div className="owner-allowances">{mandates.filter((m) => m.status === "active").slice(0, 6).map((m) => <div key={m.address}><button className="owner-text-action owner-token-heading" onClick={() => onPermission(m.address)}><TokenIcon mint={m.allowedMint} />{mandateDisplayName(m, mandates, assets)}</button><SpendMeter spent={m.amountSpent} limit={m.totalLimit} decimals={decimals[m.allowedMint] ?? null} symbol={symbol(m.allowedMint)} /></div>)}</div><p className="owner-caption">Totals reflect the loaded permissions. Remaining allowance is not a wallet balance.</p></section>
    <div className="owner-overview-columns"><section className="dashboard-card"><div className="dashboard-card-heading"><h2>Your agents</h2><Button label="View agents" variant="ghost" onClick={onAgents} /></div>{connectionError ? <p role="alert">Agent activity could not be refreshed.</p> : connections.length ? connections.slice(0, 5).map((connection) => <button className="owner-agent-row" key={connection.id} onClick={onAgents}><span className="owner-row-icon neutral"><Bot /></span><span><strong>{connection.agentName}</strong><small>{connectionSeenLabel(connection.lastSeenAt)}</small></span><span className={`owner-status ${connectionIsLive(connection.lastSeenAt) ? "good" : ""}`}>{connectionIsLive(connection.lastSeenAt) ? "Connected" : "Configured"}</span></button>) : <div className="owner-small-empty"><Bot /><p>Connect an agent to use your spending permissions.</p><Button label="Connect agent" variant="secondary" onClick={onAgents} /></div>}</section>
    <section className="dashboard-card"><div className="dashboard-card-heading"><h2>Recent activity</h2><Button label="View payments" variant="ghost" onClick={onPayments} /></div>{activity.length ? activity.slice(0, 5).map((row) => <div className="owner-activity-row" key={`${row.source}:${row.id}`}><span><strong>{row.label}</strong><small>{row.status.replaceAll("_", " ")}</small></span>{row.receiptAddress ? <a href={publicReceiptPath(row.receiptAddress)}>Receipt <ArrowRight size={16} /></a> : <Button label="View request" variant="ghost" onClick={onRequests} />}</div>) : <div className="owner-small-empty"><Inbox /><p>Your requests and payment activity will appear here.</p></div>}</section></div>
    <footer className="owner-page-footer"><ShieldCheck size={16} />Your wallet. Your permissions.</footer>
  </div>;
}
