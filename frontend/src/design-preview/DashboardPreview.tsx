import { useEffect, useRef, useState, type ReactNode } from "react";
import { Theme } from "@astryxdesign/core/theme";
import { Button } from "@astryxdesign/core/Button";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Popover } from "@astryxdesign/core/Popover";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Layout, LayoutContent } from "@astryxdesign/core/Layout";
import { ArrowLeft, ArrowRight, ArrowUpRight, Bot, Check, CheckCheck, ChevronDown, ChevronRight, CircleAlert, Clock3, Copy, FileText, House, Inbox, KeyRound, LayoutGrid, LogOut, Menu, Plus, Settings2, ShieldCheck, SlidersHorizontal, Sparkles, Wallet, X } from "lucide-react";
import { chainPayTheme } from "../theme/chainpay-theme";
import { BrandLogo } from "../brand/Brand";
import { parseTokenAmount, formatTokenAmount } from "../owner/amounts";
import usdc from "../assets/brands/usdc.svg";
import pyusd from "../assets/brands/pyusd.png";
import phantom from "../assets/brands/phantom.svg";
import solflare from "../assets/brands/solflare.svg";
import "./dashboard-preview.css";

type Scenario = "attention" | "healthy" | "empty" | "loading" | "error" | "setup";
type Screen = "overview" | "permissions" | "create";
type Detail = "request" | "agent" | "payment" | "permission" | null;
const sampleWallet = "Sample wallet · 7Hn9…mK2p";
const navigation = [
  { label: "Overview", icon: House, screen: "overview" },
  { label: "Agents", icon: Bot },
  { label: "Spending permissions", icon: ShieldCheck, screen: "permissions" },
  { label: "Requests", icon: Inbox },
  { label: "Payments", icon: ArrowUpRight },
] as const;
const permissions = [
  { name: "Research assistant", purpose: "Research & discovery", token: "USDC", spent: "106.50", limit: "300", remaining: "193.50", percent: 35.5, letter: "R", tone: "blue" },
  { name: "Content assistant", purpose: "Content & publishing", token: "USDC", spent: "42.00", limit: "150", remaining: "108.00", percent: 28, letter: "C", tone: "violet" },
  { name: "Data assistant", purpose: "Data & analysis", token: "PYUSD", spent: "32.00", limit: "100", remaining: "68.00", percent: 32, letter: "D", tone: "teal" },
];

function Action({ label, onClick, primary = false, icon, disabled = false }: { label: string; onClick: () => void; primary?: boolean; icon?: ReactNode; disabled?: boolean }) {
  return <Button className={`dp-button ${primary ? "dp-primary" : ""}`} label={label} onClick={onClick} variant={primary ? "primary" : "secondary"} icon={icon} isDisabled={disabled} />;
}
function Status({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "good" | "warning" }) {
  return <span className={`dp-status ${tone}`}><span aria-hidden="true" />{children}</span>;
}
function Avatar({ letter, tone = "blue" }: { letter: string; tone?: string }) {
  return <span className={`dp-avatar ${tone}`} aria-hidden="true">{letter}</span>;
}
function Token({ token }: { token: string }) {
  return <img className="dp-token" src={token === "USDC" ? usdc : pyusd} alt="" />;
}
function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  return <Dialog isOpen onOpenChange={(open) => { if (!open) onClose(); }} width={520} purpose="info" className="dp-dialog"><Layout height="auto" header={<DialogHeader title={title} onOpenChange={(open) => { if (!open) onClose(); }} />} content={<LayoutContent><div className="dp-modal-content">{children}</div></LayoutContent>} /></Dialog>;
}

export function DashboardPreview() {
  const [scenario, setScenario] = useState<Scenario>("attention");
  const [screen, setScreen] = useState<Screen>("overview");
  const [mobileNav, setMobileNav] = useState(false);
  const [walletMenu, setWalletMenu] = useState(false);
  const [walletStep, setWalletStep] = useState<"choose" | "connect" | "sign" | null>(null);
  const [walletName, setWalletName] = useState("Phantom");
  const [signedIn, setSignedIn] = useState(true);
  const [copied, setCopied] = useState(false);
  const [detail, setDetail] = useState<Detail>(null);
  const [resolved, setResolved] = useState(false);
  const [recordIndex, setRecordIndex] = useState(0);
  const [notice, setNotice] = useState("");
  const [created, setCreated] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const attention = scenario === "attention";
  const attentionCount = resolved ? 1 : 2;
  const selectedPermission = permissions[recordIndex];
  const populated = scenario !== "empty";
  useEffect(() => { document.title = `ChainPay · ${screen === "create" ? "New permission" : screen === "permissions" ? "Spending permissions" : "Overview"} preview`; heading.current?.focus(); }, [screen]);
  useEffect(() => { setResolved(false); setCreated(false); }, [scenario]);
  useEffect(() => {
    if (!mobileNav) return;
    const sidebar = document.querySelector<HTMLElement>(".dp-sidebar");
    const getItems = () => Array.from(sidebar?.querySelectorAll<HTMLElement>("button, a[href]") ?? []);
    getItems()[0]?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); setMobileNav(false); }
      if (event.key !== "Tab") return;
      const items = getItems();
      const first = items[0]; const last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", keydown);
    return () => { document.removeEventListener("keydown", keydown); document.querySelector<HTMLButtonElement>(".dp-mobile-toggle")?.focus(); };
  }, [mobileNav]);
  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(""), 5000);
    return () => window.clearTimeout(timeout);
  }, [notice]);
  function go(next: Screen) { setScreen(next); setMobileNav(false); }
  function nextReview(label: string) { setNotice(`${label} is planned for the next design review. This preview covers Overview and spending permissions.`); setMobileNav(false); }
  const walletIcon = walletName === "Phantom" ? phantom : solflare;
  return <Theme theme={chainPayTheme} mode="light"><div className="dp-root">
    <a className="dp-skip" href="#preview-main">Skip to content</a>
    <div className="dp-review-bar"><span><span className="dp-review-dot" />Design preview <span className="dp-review-note">· Sample data, no transactions</span></span><label>Preview state<select aria-label="Preview state" value={scenario} onChange={(e) => setScenario(e.target.value as Scenario)}><option value="attention">Needs attention</option><option value="healthy">All up to date</option><option value="empty">New workspace</option><option value="loading">Loading</option><option value="error">Connection issue</option><option value="setup">Setup prerequisite</option></select></label></div>
    <div className="dp-shell">
      {mobileNav && <button className="dp-nav-scrim" aria-label="Close navigation" onClick={() => setMobileNav(false)} />}
      <aside className={`dp-sidebar ${mobileNav ? "is-open" : ""}`} aria-label="Workspace sidebar"><button className="dp-nav-close dp-icon-button" aria-label="Close menu" onClick={() => setMobileNav(false)}><X /></button>
        <a className="dp-logo" href="#overview" aria-label="ChainPay overview" onClick={(e) => { e.preventDefault(); go("overview"); }}><BrandLogo /></a>
        <div className="dp-workspace"><span className="dp-workspace-icon"><LayoutGrid size={18} /></span><span>Personal workspace<small>Owner account</small></span></div>
        <nav aria-label="Main navigation">{navigation.map(({ label, icon: Icon, ...item }) => {
          const target = "screen" in item ? item.screen : undefined;
          const active = target === screen || target === "permissions" && screen === "create";
          return <button key={label} className={`dp-nav-link ${active ? "active" : ""}`} aria-current={active ? "page" : undefined} onClick={() => target ? go(target) : nextReview(label)}><Icon /><span>{label}</span>{label === "Requests" && attention && <span className="dp-nav-count">{attentionCount}</span>}</button>;
        })}</nav>
        <div className="dp-sidebar-bottom"><button className="dp-nav-link" onClick={() => nextReview("Settings")}><Settings2 /><span>Settings</span></button><div className="dp-owner"><Avatar letter="D" tone="neutral" /><span>Your workspace<small>{signedIn ? "Signed in" : "Signed out"}</small></span></div></div>
      </aside>
      <div className="dp-workspace-body" inert={mobileNav || undefined}>
        <header className="dp-topbar"><div className="dp-breadcrumb"><button className="dp-icon-button dp-mobile-toggle" aria-label="Open navigation" aria-expanded={mobileNav} onClick={() => setMobileNav(!mobileNav)}><Menu /></button><span>Workspace</span><ChevronRight size={14} /><strong>{screen === "overview" ? "Overview" : "Spending permissions"}</strong></div><div className="dp-account"><span className="dp-network"><span />Devnet</span>{signedIn ? <Popover isOpen={walletMenu} onOpenChange={setWalletMenu} label="Connected wallet" alignment="end" width={280} content={<div className="dp-wallet-popover"><div className="dp-wallet-heading"><img src={walletIcon} alt="" /><div><strong>{walletName}</strong><span>Sample wallet · 7Hn9…mK2p</span></div></div><div className="dp-wallet-balances"><div><span><Token token="USDC" />USDC</span><b>750.00</b></div><div><span><Token token="PYUSD" />PYUSD</span><b>200.00</b></div></div><button onClick={() => { void navigator.clipboard.writeText(sampleWallet).then(() => setCopied(true)).catch(() => setNotice("Clipboard unavailable. Sample address: 7Hn9…mK2p")); }}><Copy />{copied ? "Sample label copied" : "Copy sample wallet label"}</button><button onClick={() => { setWalletMenu(false); setWalletStep("choose"); }}><Wallet />Change wallet</button><button onClick={() => { setWalletMenu(false); setSignedIn(false); }}><LogOut />Disconnect preview wallet</button></div>}><button className="dp-wallet-trigger"><img src={walletIcon} alt="" /><span>7Hn9…mK2p</span><ChevronDown size={14} /></button></Popover> : <Action label="Connect wallet" onClick={() => setWalletStep("choose")} icon={<Wallet />} />}</div></header>
        <main id="preview-main" className="dp-main" tabIndex={-1}>
          {screen === "create" ? <PermissionWizard scenario={scenario} headingRef={heading} onBack={() => go("permissions")} onComplete={() => { setCreated(true); go("permissions"); }} /> : <>
            <div className="dp-page-heading"><div><h1 ref={heading} tabIndex={-1}>{screen === "overview" ? "Overview" : "Spending permissions"}</h1><p>{screen === "overview" ? "Your agents, spending, and what needs you." : "Decide how much your agents can spend."}</p></div><Action label="New permission" primary icon={<Plus />} onClick={() => go("create")} /></div>
            {scenario === "loading" ? <div className="dp-loading" role="status" aria-label="Loading workspace"><span className="dp-skeleton" /><span className="dp-skeleton" /><span className="dp-skeleton" /><p>Loading your workspace…</p></div> : scenario === "error" ? <div className="dp-empty"><CircleAlert /><h2>We couldn’t refresh your workspace</h2><p>Your spending permissions haven’t changed. Reconnect to see their current status.</p><Action label="Try again" primary onClick={() => setScenario("healthy")} /></div> : screen === "permissions" ? <>
              {created && <div className="dp-inline-success" role="status"><CheckCheck /><span>Permission preview complete. No permission was created on-chain.</span></div>}
              {populated ? <div className="dp-permission-list">{permissions.map((p, index) => <button key={p.name} onClick={() => { setRecordIndex(index); setDetail("permission"); }} className="dp-permission-row"><Avatar letter={p.letter} tone={p.tone} /><span className="dp-record-title"><strong>{p.name}</strong><small>{p.purpose}</small></span><span className="dp-permission-amount"><strong>{p.remaining} {p.token}</strong><small>of {p.limit} remaining</small></span><Status tone="good">Active</Status><ChevronRight /></button>)}</div> : <EmptyWorkspace onCreate={() => go("create")} />}
            </> : <>
              {!populated ? <EmptyWorkspace onCreate={() => go("create")} /> : <>
                <section className={`dp-attention ${attention ? "" : "is-clear"}`} aria-labelledby="attention-title"><div className="dp-section-heading"><h2 id="attention-title">{attention ? "Needs your attention" : "You’re up to date"}</h2>{attention ? <span className="dp-count">{attentionCount} {attentionCount === 1 ? "item" : "items"}</span> : <CheckCheck className="dp-success-icon" />}</div>{attention ? <div className="dp-attention-list">{!resolved && <button className="dp-attention-row" onClick={() => setDetail("request")}><span className="dp-attention-icon"><Inbox /></span><span className="dp-record-title"><strong>A payment is ready for review</strong><small>Research assistant · API access</small></span><span className="dp-attention-value">8.50 <small>USDC</small></span><span className="dp-row-action">Review <ArrowRight /></span></button>}<button className="dp-attention-row" onClick={() => { setRecordIndex(2); setDetail("permission"); }}><span className="dp-attention-icon neutral"><Clock3 /></span><span className="dp-record-title"><strong>Data assistant’s permission expires tomorrow</strong><small>Review its limits to keep it working.</small></span><span className="dp-row-action">View permission <ArrowRight /></span></button></div> : <p>No approvals waiting. Your agents are working within their permissions.</p>}</section>
                <section className="dp-spending" aria-labelledby="spending-title"><div className="dp-section-heading"><h2 id="spending-title">Spending overview</h2><span className="dp-muted">Across current permissions</span></div><div className="dp-spend-totals"><div><span><Token token="USDC" />USDC spent</span><strong>148.50 <small>USDC</small></strong><p>301.50 USDC allowance remaining</p></div><div><span><Token token="PYUSD" />PYUSD spent</span><strong>32.00 <small>PYUSD</small></strong><p>68.00 PYUSD allowance remaining</p></div><div className="dp-spend-note"><ShieldCheck /><p>Spending stays within<br />the limits you set.</p><button className="dp-text-link" onClick={() => go("permissions")}>Manage permissions <ArrowRight /></button></div></div><div className="dp-allowance-list">{permissions.map((p) => <div className="dp-allowance" key={p.name}><div><span>{p.name}</span><span><b>{p.spent}</b> / {p.limit} {p.token}</span></div><meter min={0} max={100} value={p.percent} aria-label={`${p.name} allowance used`} /><small>{p.remaining} {p.token} remaining</small></div>)}</div></section>
                <div className="dp-bottom-grid"><section className="dp-agents" aria-labelledby="agents-title"><div className="dp-section-heading"><h2 id="agents-title">Your agents <span className="dp-count">3</span></h2><button className="dp-text-link" onClick={() => nextReview("Agents")}>View all <ArrowUpRight /></button></div>{permissions.map((p, i) => <button className="dp-agent-row" key={p.name} onClick={() => { setRecordIndex(i); setDetail("agent"); }}><Avatar letter={p.letter} tone={p.tone} /><span className="dp-record-title"><strong>{p.name}</strong><small>{i === 0 ? "Active 2 minutes ago" : i === 1 ? "Active 24 minutes ago" : "No recent connection activity"}</small></span><Status tone={i === 2 ? "neutral" : "good"}>{i === 2 ? "Configured" : "Connected"}</Status></button>)}</section>
                <section className="dp-activity" aria-labelledby="activity-title"><div className="dp-section-heading"><h2 id="activity-title">Recent payments</h2><button className="dp-text-link" onClick={() => nextReview("Payments")}>View all <ArrowUpRight /></button></div>{[{ title: "API access", agent: "Research assistant", amount: "4.50 USDC", time: "12 min ago" }, { title: "Content generation", agent: "Content assistant", amount: "12.00 USDC", time: "1 hour ago" }, { title: "Data request", agent: "Data assistant", amount: "2.00 PYUSD", time: "2 hours ago" }].map((p, i) => <button className="dp-payment-row" key={p.title} onClick={() => { setRecordIndex(i); setDetail("payment"); }}><span className="dp-payment-icon"><ArrowUpRight /></span><span className="dp-record-title"><strong>{p.title}</strong><small>{p.agent} · {p.time}</small></span><span className="dp-payment-value"><b>{p.amount}</b><small><Check />Paid</small></span></button>)}</section></div>
              </>}
              <footer className="dp-page-footer"><span><ShieldCheck size={14} />Your wallet. Your permissions.</span><span>Sample workspace · Solana Devnet</span></footer>
            </>}
          </>}
        </main>
      </div>
    </div>
    {notice && <div className="dp-toast" role="status"><span>{notice}</span><button aria-label="Dismiss notice" onClick={() => setNotice("")}><X /></button></div>}
    {walletStep && <Modal title={walletStep === "choose" ? "Choose your wallet" : walletStep === "connect" ? "Connect your wallet" : "Sign in to ChainPay"} onClose={() => setWalletStep(null)}><div className="dp-dialog-intro"><span className="dp-modal-symbol"><Wallet /></span><p>{walletStep === "choose" ? "Choose the wallet you want to use for your workspace." : walletStep === "connect" ? `Connect ${walletName} to continue. You stay in control of your funds.` : "A login message confirms this workspace is yours. It does not authorize spending."}</p></div>{walletStep === "choose" ? <div className="dp-wallet-choices">{[{ name: "Phantom", icon: phantom }, { name: "Solflare", icon: solflare }].map((w) => <button key={w.name} onClick={() => { setWalletName(w.name); setWalletStep("connect"); }}><img src={w.icon} alt="" /><strong>{w.name}</strong><span>Sample wallet</span><ChevronRight /></button>)}</div> : <Action label={walletStep === "connect" ? "Simulate connection" : "Simulate sign-in"} primary onClick={() => { if (walletStep === "connect") setWalletStep("sign"); else { setSignedIn(true); setWalletStep(null); setNotice("Preview signed in. No wallet was connected and no message was signed."); } }} />}<p className="dp-caption">Design preview only. Your browser wallet will not open.</p></Modal>}
    {detail && <Modal title={detail === "request" ? "Review payment" : detail === "agent" ? "Agent overview" : detail === "permission" ? "Permission overview" : "Payment receipt"} onClose={() => setDetail(null)}>
      <Status tone={detail === "request" ? "warning" : detail === "agent" && recordIndex === 2 ? "neutral" : "good"}>{detail === "request" ? "Needs your approval" : detail === "payment" ? "Paid · sample" : detail === "agent" && recordIndex === 2 ? "Configured · sample" : "Active · sample"}</Status>
      <div className="dp-detail-hero">{detail === "request" ? "8.50" : detail === "payment" ? ["4.50", "12.00", "2.00"][recordIndex] : selectedPermission.name}{(detail === "request" || detail === "payment") && <small> {detail === "request" ? "USDC" : selectedPermission.token}</small>}</div>
      <dl className="dp-review-values"><div><dt>Agent</dt><dd>{detail === "request" ? "Research assistant" : selectedPermission.name}</dd></div><div><dt>Purpose</dt><dd>{detail === "request" ? "API access" : selectedPermission.purpose}</dd></div><div><dt>Total allowance</dt><dd>{detail === "request" ? "300 USDC" : `${selectedPermission.limit} ${selectedPermission.token}`}</dd></div><div><dt>Network</dt><dd>Solana Devnet</dd></div>{detail === "permission" && attention && recordIndex === 2 && <div><dt>Expires</dt><dd>Tomorrow · estimated</dd></div>}</dl>
      <p className="dp-caption">Illustrative record for layout review. There is no real recipient, transaction, or receipt behind this sample.</p>
      {detail === "request" ? <Action label="Simulate approval" primary onClick={() => { setDetail(null); setResolved(true); setNotice("Sample payment review completed. Nothing was signed or paid."); }} /> : detail === "permission" ? <Action label="Preview new permission" onClick={() => { setDetail(null); go("create"); }} /> : <Action label="Close" onClick={() => setDetail(null)} />}
    </Modal>}
  </div></Theme>;
}

function EmptyWorkspace({ onCreate }: { onCreate: () => void }) {
  return <section className="dp-empty"><div className="dp-empty-symbol"><ShieldCheck /></div><h2>Your first agent starts with a permission</h2><p>Choose how much it can spend and when to ask you. Then connect your agent.</p><Action label="Set spending limits" primary icon={<Plus />} onClick={onCreate} /><ol className="dp-empty-steps"><li><ShieldCheck /><span>Set your limits</span></li><li><Wallet /><span>Approve in your wallet</span></li><li><Bot /><span>Connect your agent</span></li></ol></section>;
}

function PermissionWizard({ scenario, headingRef, onBack, onComplete }: { scenario: Scenario; headingRef: React.RefObject<HTMLHeadingElement | null>; onBack: () => void; onComplete: () => void }) {
  const [step, setStep] = useState(0);
  const [mode, setMode] = useState("human");
  const [token, setToken] = useState("USDC");
  const [perPayment, setPerPayment] = useState("25");
  const [total, setTotal] = useState("300");
  const [expiry, setExpiry] = useState("30");
  const [maxCount, setMaxCount] = useState("0");
  const [cooldown, setCooldown] = useState("0");
  const [error, setError] = useState("");
  const [ready, setReady] = useState(scenario !== "setup");
  const [setupOpen, setSetupOpen] = useState(false);
  const [completed, setCompleted] = useState(false);
  const stepHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { setReady(scenario !== "setup"); }, [scenario]);
  useEffect(() => { stepHeading.current?.focus(); }, [step, completed]);
  function next() {
    setError("");
    if (step === 1) {
      try {
        const per = parseTokenAmount(perPayment, 6);
        const budget = parseTokenAmount(total, 6);
        if (per <= 0n || budget <= 0n) throw new Error("Enter an amount greater than zero for both limits.");
        if (per > budget) throw new Error("The per-payment limit cannot exceed the total allowance.");
        if (![maxCount, cooldown].every((value) => /^\d+$/.test(value))) throw new Error("Advanced limits must be whole numbers of zero or more.");
        if (!ready) throw new Error("Prepare your token account before continuing.");
      } catch (cause) { setError(cause instanceof Error ? cause.message : "Check your limits."); return; }
    }
    setStep(step + 1);
  }
  return <div className="dp-wizard"><button className="dp-back" onClick={onBack}><ArrowLeft />Spending permissions</button><div className="dp-page-heading"><div><h1 ref={headingRef} tabIndex={-1}>New spending permission</h1><p>A few clear limits. You stay in control.</p></div></div><ol className="dp-stepper" aria-label="Permission setup steps">{["Approval method", "Spending limits", "Review"].map((label, i) => <li key={label} className={i === step ? "current" : i < step ? "done" : ""} aria-current={i === step ? "step" : undefined}><span>{i < step ? <Check /> : i + 1}</span><b>{label}</b></li>)}</ol>
    <div className="dp-wizard-grid"><section className="dp-form-panel">
      {completed ? <div className="dp-wizard-success"><span className="dp-success-circle"><CheckCheck /></span><h2 ref={stepHeading} tabIndex={-1}>Your permission is ready</h2><p>This completes the preview. In the live app, this step follows a confirmed wallet approval.</p><div className="dp-next-step"><Bot /><div><strong>Next, connect your agent</strong><p>Give it access to this permission and copy its connection configuration.</p></div></div><Action label="Finish preview" primary onClick={onComplete} /><p className="dp-caption">No permission was created. No wallet was opened.</p></div> : <>
        <div className="dp-form-heading"><span className="dp-step-label">Step {step + 1} of 3</span><h2 ref={stepHeading} tabIndex={-1}>{step === 0 ? "How should payments be approved?" : step === 1 ? "Set your spending limits" : "Everything look right?"}</h2><p>{step === 0 ? "Choose when you want your wallet to ask you." : step === 1 ? "Your agent can only spend within these limits." : "Review the permission before continuing to your wallet."}</p></div>
        {step === 0 && <fieldset className="dp-mode-options"><legend className="dp-visually-hidden">Payment approval method</legend>{[{ value: "human", icon: Wallet, title: "Ask me each time", copy: "Review and approve every payment in your wallet.", note: "More control over each payment" }, { value: "automatic", icon: Sparkles, title: "Automatically within my limits", copy: "Approve the permission once. Your agent can then pay within it.", note: "Requires automatic-payment setup" }].map(({ value, icon: Icon, title, copy, note }) => <label key={value} className={`dp-mode ${mode === value ? "selected" : ""}`}><input type="radio" name="approval-method" value={value} checked={mode === value} onChange={() => setMode(value)} /><span className="dp-mode-icon"><Icon /></span><span><strong>{title}</strong><span>{copy}</span><small>{note}</small></span></label>)}</fieldset>}
        {step === 1 && <div className="dp-fields"><label className="dp-select-field">Token<select value={token} onChange={(e) => setToken(e.target.value)}><option>USDC</option><option>PYUSD</option></select></label><div className="dp-field-pair"><TextInput label={`Maximum per payment (${token})`} value={perPayment} onChange={(value) => { setPerPayment(value); setError(""); }} isRequired /><TextInput label={`Total allowance (${token})`} value={total} onChange={(value) => { setTotal(value); setError(""); }} isRequired /></div><label className="dp-select-field">Permission expires in<select value={expiry} onChange={(e) => setExpiry(e.target.value)}><option value="1">1 day</option><option value="7">7 days</option><option value="30">30 days</option><option value="90">90 days</option></select><small>Approximate duration. The exact expiry is recorded on-chain.</small></label><details className="dp-advanced"><summary><SlidersHorizontal />Advanced limits<ChevronDown /></summary><div className="dp-field-pair"><TextInput label="Maximum payment count" description="0 means no count limit." value={maxCount} onChange={(value) => { setMaxCount(value); setError(""); }} /><TextInput label="Cooldown in slots" description="0 means no cooldown." value={cooldown} onChange={(value) => { setCooldown(value); setError(""); }} /></div></details>{!ready && <div className="dp-prerequisite"><CircleAlert /><div><strong>Your token account needs setup</strong><p>Creating it requires a separate wallet approval and a network fee.</p><Action label="Preview account setup" onClick={() => setSetupOpen(true)} /></div></div>}{mode === "automatic" && <div className="dp-inline-note"><KeyRound /><p>In the live flow, a secure payment signer must be set up and funded for network fees before approval. Availability is simulated here.</p></div>}</div>}
        {step === 2 && <><div className="dp-review-budget"><Token token={token} /><span>Total allowance<strong>{formatTokenAmount(parseTokenAmount(total, 6), 6)} <small>{token}</small></strong></span></div><dl className="dp-review-values"><div><dt>Payment approval</dt><dd>{mode === "human" ? "Ask me each time" : "Automatic within limits"}</dd></div><div><dt>Maximum per payment</dt><dd>{formatTokenAmount(parseTokenAmount(perPayment, 6), 6)} {token}</dd></div><div><dt>Expires in</dt><dd>About {expiry} {expiry === "1" ? "day" : "days"}</dd></div><div><dt>Recipient</dt><dd>Chosen per payment</dd></div><div><dt>Payment count</dt><dd>{BigInt(maxCount) === 0n ? "No count limit" : maxCount}</dd></div><div><dt>Cooldown</dt><dd>{BigInt(cooldown) === 0n ? "None" : `${cooldown} slots`}</dd></div><div><dt>Owner wallet</dt><dd>7Hn9…mK2p <small>(sample)</small></dd></div></dl><details className="dp-advanced"><summary><FileText />Technical details<ChevronDown /></summary><p>This preview has no prepared transaction or exact expiry slot. The live review will show the prepared transaction and its on-chain expiry before wallet approval.</p></details><div className="dp-inline-note"><ShieldCheck /><p>In the live app, approving creates a spending permission. It is separate from signing in.</p></div></>}
        {error && <p className="dp-form-error" role="alert"><CircleAlert />{error}</p>}
        <div className="dp-form-actions"><Action label={step === 0 ? "Cancel" : "Back"} onClick={() => { setError(""); if (step === 0) onBack(); else setStep(step - 1); }} /><Action label={step === 0 ? "Set spending limits" : step === 1 ? "Review permission" : "Simulate wallet approval"} primary icon={step === 2 ? <Wallet /> : <ArrowRight />} onClick={() => step === 2 ? setCompleted(true) : next()} /></div>
      </>}
    </section><aside className="dp-wizard-aside"><span className="dp-aside-symbol"><ShieldCheck /></span><h2>A permission,<br />on your terms.</h2><p>Your funds stay in your wallet. You choose the limits and can revoke the permission at any time.</p><div className="dp-rule-list"><div><Check /><span>{mode === "human" ? "You approve each payment" : "Payments stay within your limits"}</span></div><div><Check /><span>A receipt for every payment</span></div><div><Check /><span>Revoke access when you need to</span></div></div><div className="dp-aside-footer"><span className="dp-network"><span />Solana Devnet</span><small>Sample setup · no real approval</small></div></aside></div>
    {setupOpen && <Modal title="Prepare your token account" onClose={() => setSetupOpen(false)}><p>A token account lets your wallet hold {token}. Creating one in the live app requires your approval and a network fee, shown before signing.</p><p className="dp-caption">This sample does not create an account or charge a fee.</p><Action label="Simulate account preparation" primary onClick={() => { setReady(true); setSetupOpen(false); setError(""); }} /></Modal>}
  </div>;
}
