import { TextInput } from "@astryxdesign/core/TextInput";
import { Slider } from "@astryxdesign/core/Slider";
import { TokenIcon } from "../ui/TokenIcon";

export function SpendingAmountField({ label, value, onChange, token, mint, rangeMax, description }: {
  label: string; value: string; onChange: (value: string) => void; token: string; mint: string; rangeMax: number; description: string;
}) {
  // This conversion only positions the convenience slider. The authoritative
  // decimal string stays untouched until the user explicitly moves the slider.
  const numeric = /^\d+(\.\d*)?$/.test(value) ? Number(value) : 0;
  const position = Number.isFinite(numeric) ? Math.min(rangeMax, Math.max(1, numeric)) : rangeMax;
  return <div className="owner-amount-field">
    <div className="owner-amount-header"><span>{label}</span><div className="owner-amount-token"><TokenIcon mint={mint} /><span>{token}</span></div></div>
    <TextInput label={label} isLabelHidden value={value} onChange={onChange} placeholder="0" />
    <p>{description}</p>
    <div className="owner-amount-slider"><Slider label={`Quick ${label.toLowerCase()}`} isLabelHidden min={1} max={rangeMax} step={1} value={position} onChange={(amount: number) => onChange(String(Math.round(amount)))} /></div>
    <div className="owner-range-labels"><span>1 {token}</span><span>{rangeMax.toLocaleString()} {token}</span></div>
    <small>{numeric > rangeMax ? "Custom amount. " : ""}Slide for whole tokens. Type above for an exact amount.</small>
  </div>;
}
