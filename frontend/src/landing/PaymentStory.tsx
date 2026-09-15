import { AssetMark } from "./SupportedAssets";
import { Button } from "@astryxdesign/core/Button";

export function PermissionExample() {
  return <article className="story-document">
    <div className="story-document-head"><span>Spending permission</span><span className="story-tag">Example</span></div>
    <div className="story-agent"><span className="story-agent-symbol" aria-hidden="true">↗</span><div><h3>Research agent</h3><p>One agent. A defined allowance.</p></div></div>
    <dl className="story-fields"><div><dt>Token</dt><dd className="story-token"><AssetMark asset="USDC" />USDC</dd></div><div><dt>Per-payment limit</dt><dd>10 USDC</dd></div><div><dt>Total allowance</dt><dd>100 USDC</dd></div><div><dt>Payment mode</dt><dd>Approve each payment</dd></div></dl>
    <p className="story-document-note">You review the effective settings before approving in your wallet.</p>
  </article>;
}

export function PaymentExample() {
  return <article className="story-document">
    <div className="story-document-head"><span>Payment review</span><span className="story-tag">Example</span></div>
    <p className="story-overline">Research agent requests</p><h3 className="story-amount">4.50 <span className="story-token"><AssetMark asset="USDC" />USDC</span></h3>
    <dl className="story-fields"><div><dt>Recipient</dt><dd>Example service</dd></div><div><dt>Per-payment check</dt><dd>4.50 of 10 USDC</dd></div><div><dt>Allowance check</dt><dd>4.50 of 100 USDC</dd></div></dl>
    <div className="story-check">Within the example amount limits</div>
    <p className="story-document-note">Other permission checks and wallet approval still apply. Nothing is submitted here.</p>
  </article>;
}

export function ReceiptExample() {
  return <article className="story-document story-receipt">
    <div className="story-document-head"><span className="story-wordmark">chainpay</span><span>Payment receipt</span></div>
    <p className="story-overline">Illustrative receipt · no payment made</p><h3 className="story-amount">4.50 <span className="story-token"><AssetMark asset="USDC" />USDC</span></h3>
    <dl className="story-fields"><div><dt>Agent</dt><dd>Research agent</dd></div><div><dt>Recipient</dt><dd>Example service</dd></div><div><dt>Network</dt><dd className="story-token"><AssetMark asset="Solana" />Solana Devnet</dd></div></dl>
    <div className="story-evidence"><strong>Payment verification</strong><p>A live receipt reports the verified settlement state.</p><strong>No seller statement</strong><p>Seller evidence is separate from payment verification.</p></div>
    <p className="story-document-note">Public receipts exclude private request text and attachments. Current permission settings are not a historical snapshot.</p>
  </article>;
}

export function ControlExample() {
  return <article className="story-document">
    <div className="story-document-head"><span>Research agent</span><span className="story-tag">After the example payment</span></div>
    <p className="story-overline">Allowance remaining</p><h3 className="story-amount">95.50 <span className="story-token"><AssetMark asset="USDC" />USDC</span></h3>
    <div className="story-allowance" aria-hidden="true"><span /></div><p className="story-document-note">4.50 USDC spent of 100 USDC</p>
    <dl className="story-fields"><div><dt>Payment</dt><dd>4.50 USDC · example</dd></div><div><dt>Receipt</dt><dd>Linked to the payment</dd></div></dl>
    <div className="story-control-note"><strong>Pause when plans change.</strong><p>Pause and revoke stop future execution. They do not cancel a submitted payment or change an earlier receipt.</p></div>
  </article>;
}

const chapters = [
  { id: "spend-limits", number: "01", label: "SET THE PERMISSION", title: "Give the work a budget.", body: "Your agent has a job to do. You decide how much it can spend doing it. Choose the agent, token, per-payment limit, total allowance and expiry.", detail: "That spending permission is called a mandate. Its rules are enforced on-chain.", visual: PermissionExample },
  { id: "payment-review", number: "02", label: "PAY WITHIN THE LIMITS", title: "A small payment. A clear decision.", body: "The agent requests 4.50 USDC. See the amount, recipient and permission together before you continue to your wallet.", detail: "Choose approval for each payment, or automatic payments within a permission when the required agent-signing setup is available.", visual: PaymentExample },
  { id: "receipts", number: "03", label: "KEEP THE RECEIPT", title: "The payment ends.\nThe evidence stays.", body: "After settlement, open a receipt that shows who paid, how much, and where it went. Share the public link with someone who has never connected a wallet.", detail: "Payment verification stands on its own. A seller statement, when available, is separate evidence about the response served.", visual: ReceiptExample },
  { id: "stay-in-control", number: "04", label: "STAY IN CONTROL", title: "More room to work.\nYou still set the limits.", body: "Follow spending and remaining allowances in the dashboard. Inspect a permission, pause future payments, or revoke access when the job is done.", detail: "A blocked payment stays blocked until you take action. Changing a permission never automatically retries it.", visual: ControlExample },
];

export function PaymentStory({ onOpenDashboard }: { onOpenDashboard: () => void }) {
  return <section id="how-it-works" className="payment-story" aria-labelledby="story-heading">
    <div className="story-intro page-width"><p className="section-kicker">FROM INTENT TO RECEIPT</p><h2 id="story-heading">One agent. One payment.<br /><span>You, in control throughout.</span></h2><p>Follow an illustrative 4.50 USDC payment from its first limit to its final record. No payment is made in this example.</p></div>
    <div className="story-sequence page-width">
      <div className="story-morph" aria-hidden="true">
        <div className="story-morph-label"><span>RESEARCH AGENT</span><span>Illustrative example</span></div>
        <div className="story-satellite story-satellite-agent"><span className="satellite-label">YOUR PERMISSION</span><strong>Research agent</strong><span>10 USDC per payment</span></div>
        <div className="story-satellite story-satellite-token"><AssetMark asset="USDC" /><div><span className="satellite-label">SAME PAYMENT</span><strong>4.50 USDC</strong><span>Illustrative example</span></div></div>
        <div className="story-connection story-connection-agent" /><div className="story-connection story-connection-token" />
        <div className="story-morph-frame">{chapters.map(({id, visual: Visual}) => <div className="story-morph-state" key={id}><Visual /></div>)}</div>
        <div className="story-network"><AssetMark asset="Solana" /><span>On Solana Devnet</span><span className="story-network-alternative"><AssetMark asset="PYUSD" />PYUSD also supported</span></div>
        <div className="story-morph-progress"><span /></div>
        <div className="story-morph-steps"><span>Permission</span><span>Payment</span><span>Receipt</span><span>Control</span></div>
      </div>
      <div className="story-chapters">{chapters.map(({id, number, label, title, body, detail, visual: Visual}) => <section id={id} className="story-chapter" key={id} aria-labelledby={`${id}-heading`}>
      <div className="story-copy"><p className="story-step"><span>{number}</span>{label}</p><h2 id={`${id}-heading`}>{title}</h2><p className="story-body">{body}</p><p className="story-detail">{detail}</p>{number === "04" && <Button variant="primary" label="Open dashboard" onClick={onOpenDashboard} />}</div>
      <div className={`story-stage story-stage-${number}`}><Visual /></div>
    </section>)}</div></div>
  </section>;
}
