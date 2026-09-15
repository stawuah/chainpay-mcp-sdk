/** Print only the public receipt document, never the surrounding private inbox. */
export function printableReceipt(card: HTMLElement): HTMLElement {
  const copy = card.cloneNode(true) as HTMLElement;
  copy.querySelectorAll(".receipt-card-actions, .receipt-share-status").forEach((node) => node.remove());
  copy.querySelectorAll("details").forEach((details) => { details.open = true; });
  return copy;
}

export function printReceipt(card: HTMLElement): void {
  const frame = document.createElement("iframe");
  frame.title = "Print ChainPay receipt";
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText = "position:fixed;width:1px;height:1px;left:-10000px;border:0";
  document.body.appendChild(frame);
  const doc = frame.contentDocument;
  const printWindow = frame.contentWindow;
  if (!doc || !printWindow) { frame.remove(); return; }
  doc.title = "ChainPay payment receipt";
  const style = doc.createElement("style");
  style.textContent = `
    @page { margin: 18mm; }
    body { margin: 0; font: 12px/1.5 system-ui, sans-serif; color: #172b4d; background: white; }
    .receipt-brand { color: #174de6; font-size: 22px; font-weight: 700; }
    .receipt-card-heading { display: flex; justify-content: space-between; gap: 20px; }
    h3 { font-size: 24px; margin: 8px 0; }
    small { display: block; font-size: 11px; font-weight: 400; }
    dl { display: grid; grid-template-columns: 145px minmax(0, 1fr); gap: 6px 14px; }
    dd { margin: 0; overflow-wrap: anywhere; font-family: monospace; }
    dt, summary { font-weight: 600; }
    .receipt-stamp { border: 1px solid #ccd3df; padding: 12px; margin: 10px 0; break-inside: avoid; }
    .receipt-stamp-mark { display: none; }
    .receipt-stamp p { margin: 4px 0; overflow-wrap: anywhere; }
    details { margin: 16px 0; }
    .receipt-public-url, a { overflow-wrap: anywhere; color: inherit; }
    .receipt-summary, .receipt-card-heading, .receipt-public-url { break-inside: avoid; }
  `;
  doc.head.appendChild(style);
  doc.body.appendChild(doc.importNode(printableReceipt(card), true));
  printWindow.addEventListener("afterprint", () => frame.remove(), { once: true });
  // Keep the frame alive while the native print dialog is open.
  printWindow.focus();
  printWindow.print();
}
