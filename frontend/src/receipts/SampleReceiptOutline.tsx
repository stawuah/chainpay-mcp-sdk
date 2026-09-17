import "./receipt-card.css";

/*
  The shape of a ChainPay receipt, shown when this wallet has none yet.

  This deliberately does NOT reuse ReceiptCard with invented values.
  receiptStamps() returns tone "yes" unconditionally for Allowed and Paid,
  because it only ever runs against a receipt already verified on chain — so
  feeding it fixture data would print green verification stamps for a payment
  that never happened. PRODUCT.md names simulated data presented as real as an
  anti-reference, and a false settlement claim is the worst version of it.

  So: the real field structure, the real vocabulary, no values, and stamps in
  their unproven state. It shows a reader what proof looks like without
  asserting that any proof exists.
*/
const FIELDS: { label: string; hint: string }[] = [
  { label: "Agent signing address", hint: "The agent the mandate approved" },
  { label: "Recipient token account", hint: "Where the tokens landed" },
  { label: "Executed slot", hint: "The Solana slot that finalized it" },
  { label: "Spending permission", hint: "The mandate PDA it settled under" },
];

const STAMPS: { label: string; detail: string }[] = [
  { label: "Allowed", detail: "Set when the program accepts the payment under the mandate." },
  { label: "Paid", detail: "Set from the finalized receipt on Solana, not from a submitted signature." },
  { label: "Delivered", detail: "A seller's own statement. It is never the buyer's acceptance." },
];

export function SampleReceiptOutline() {
  return (
    <section className="receipt-card is-sample" aria-labelledby="sample-receipt-title">
      <p className="sample-receipt-flag">
        Sample — no payment has settled for this wallet yet. Nothing here is a record of a real transfer.
      </p>
      <header className="sample-receipt-head">
        <span className="section-kicker">PAYMENT RECEIPT</span>
        <h3 id="sample-receipt-title">This is what your counterparty sees.</h3>
        <p>
          Every settled payment writes one of these on chain. It opens at a public link that needs no
          wallet, so a finance reader can check it without an account.
        </p>
      </header>

      <ul className="sample-receipt-stamps">
        {STAMPS.map((stamp) => (
          <li key={stamp.label}>
            <span className="sample-stamp-mark" aria-hidden="true">·</span>
            <div>
              <b>{stamp.label}</b>
              <small>{stamp.detail}</small>
            </div>
          </li>
        ))}
      </ul>

      <dl className="sample-receipt-fields">
        {FIELDS.map((field) => (
          <div key={field.label}>
            <dt>{field.label}</dt>
            <dd><span className="sample-receipt-blank" aria-label="No value yet">—</span> <small>{field.hint}</small></dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
