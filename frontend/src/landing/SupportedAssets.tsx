import { useEffect, useRef, useState } from "react";
import solana from "../assets/brands/solana.svg";
import usdc from "../assets/brands/usdc.svg";
import pyusd from "../assets/brands/pyusd.png";

const artwork = { Solana: solana, USDC: usdc, PYUSD: pyusd };
export function AssetMark({ asset }: { asset: keyof typeof artwork }) {
  return <img className={`asset-mark asset-mark-${asset.toLowerCase()}`} src={artwork[asset]} alt="" width="36" height="36" />;
}
const assets = [
  { name: "Solana", role: "Network · Devnet" },
  { name: "USDC", role: "Supported token · Devnet" },
  { name: "PYUSD", role: "PayPal USD · Devnet" },
] as const;
export function SupportedAssets() {
  const [paused, setPaused] = useState(false);
  const [visible, setVisible] = useState(false);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting));
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return <section ref={ref} className="asset-strip page-width" aria-label="Supported network and tokens">
    <div className="asset-strip-heading"><p>Built on Solana. Payments in USDC and PYUSD.</p><button className="asset-strip-pause" type="button" aria-pressed={paused} onClick={() => setPaused(!paused)}>{paused ? "Play strip" : "Pause strip"}</button></div>
    <div className="asset-strip-window"><div className={`asset-strip-track${paused || !visible ? " is-paused" : ""}`}>
      {[0, 1].map(copy => <div className="asset-strip-group" key={copy} aria-hidden={copy === 1 ? true : undefined}>{assets.map(asset => <div className="asset-strip-item" key={asset.name}><AssetMark asset={asset.name} /><div><strong>{asset.name}</strong><span>{asset.role}</span></div></div>)}</div>)}
    </div></div>
    <p className="asset-strip-note">Available in this Devnet build. Token availability follows the protocol’s asset registry.</p>
  </section>;
}
