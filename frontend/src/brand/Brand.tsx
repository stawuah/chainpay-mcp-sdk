import "./brand.css";

// One geometry for every placement. The second hook is the first rotated 180°.
export const CONNECTION_PATH = "M116 30H90C59 30 34 54 34 80C34 99 47 110 65 110";
export function BrandMark() {
  return <svg className="cp-brand-symbol" viewBox="0 0 180 180" width="32" height="32" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="28" strokeLinecap="round" strokeLinejoin="round">
    <path d={CONNECTION_PATH} /><path d={CONNECTION_PATH} transform="rotate(180 90 90)" />
  </svg>;
}
export function BrandLogo({ size = "standard" }: { size?: "compact" | "standard" | "large" }) {
  return <span className={`cp-brand cp-brand-${size}`}><BrandMark /><span className="cp-brand-wordmark">chainpay</span></span>;
}
