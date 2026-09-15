const SOLANA_ADDRESS_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function isPlausibleReceiptPda(value: string): boolean {
  return SOLANA_ADDRESS_PATTERN.test(value.trim());
}

export function VerifyPage({ receiptPda }: { receiptPda: string }) {
  const trimmed = receiptPda.trim();
  const malformed = !isPlausibleReceiptPda(trimmed);

  return (
    <main className="site-shell cp-app verify-page">
      <header className="topbar page-width">
        <a className="brand" href="/" aria-label="ChainPay home">
          <span className="brand-mark"><span /></span>
          <span>chain<span>pay</span></span>
        </a>
      </header>
      <section className="page-width" style={{ padding: "48px 0 80px" }}>
        <span className="section-kicker">PUBLIC RECEIPT</span>
        <h1 className="t-xl">Verify a payment.</h1>
        {malformed ? (
          <p className="t-body" role="alert">
            This address is not a valid Solana account. Check the receipt PDA and try again.
          </p>
        ) : (
          <>
            <p className="t-body">Receipt verification loads in a later update.</p>
            <p className="mono">{trimmed}</p>
          </>
        )}
      </section>
    </main>
  );
}

export default VerifyPage;
