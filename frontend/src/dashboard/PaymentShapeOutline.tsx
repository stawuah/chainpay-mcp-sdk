/*
  The shape of a ChainPay payment, shown when this wallet has no mandate that
  can sign from the browser.

  The tab previously rendered a single short error card in a full viewport, so
  the screen that carries the product's central act — check a payment against
  policy, then approve it — showed nothing at all about what that act involves.

  Every value here is a dash. The policy checks are the real check keys the SDK
  evaluates, in their unevaluated state. Nothing is presented as a pending or
  passing payment, because there is no payment.
*/
const REQUEST_FIELDS = [
  { label: "Amount", hint: "Exact, in the mandate's token" },
  { label: "Recipient wallet", hint: "Its token account is derived before signing" },
  { label: "Invoice reference", hint: "Hashed, so the same invoice cannot pay twice" },
  { label: "Agent signer", hint: "Fixed by the mandate, not chosen here" },
];

const CHECKS = [
  { label: "Limits", detail: "Amount is within max-per-payment and the total limit" },
  { label: "Token", detail: "Mint matches the one the mandate allows" },
  { label: "Recipient", detail: "Destination is permitted by the policy" },
  { label: "Expiry", detail: "Mandate has not passed its expiry slot" },
  { label: "Policy", detail: "Mandate is active, and the invoice is not a duplicate" },
];

export function PaymentShapeOutline() {
  return (
    <section className="payment-shape" aria-labelledby="payment-shape-title">
      <p className="payment-shape-flag">
        Nothing is prepared. This is the shape of a ChainPay payment, not a pending one.
      </p>
      <div className="payment-shape-body">
        <div className="payment-shape-request">
          <span className="section-kicker">THE REQUEST</span>
          <h3 id="payment-shape-title">What an agent asks for.</h3>
          <dl>
            {REQUEST_FIELDS.map((field) => (
              <div key={field.label}>
                <dt>{field.label}</dt>
                <dd><span className="payment-shape-blank">—</span> <small>{field.hint}</small></dd>
              </div>
            ))}
          </dl>
        </div>
        <div className="payment-shape-review">
          <span className="section-kicker">CHECKED BEFORE YOUR WALLET IS ASKED</span>
          <ul>
            {CHECKS.map((check) => (
              <li key={check.label}>
                <span className="payment-shape-mark" aria-hidden="true">·</span>
                <div><b>{check.label}</b><small>{check.detail}</small></div>
              </li>
            ))}
          </ul>
          <p className="payment-shape-note">
            Every check runs against live on-chain state. A payment that fails any of them is never
            sent to your wallet.
          </p>
        </div>
      </div>
    </section>
  );
}
