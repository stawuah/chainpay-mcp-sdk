import { useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Copy, ReceiptText } from "lucide-react";
import { TokenIcon } from "../ui/TokenIcon";
import { copyValue, type StablecoinOption } from "../owner/runtime";

const COPY_FAILED = "Could not copy. Select the address to copy it manually.";

/**
 * The mint addresses of the tokens an agent may spend.
 *
 * Setting up a payment needs the mint, not the label, and the permission flow
 * only ever shows the label. The list is whatever the registry reports as
 * enabled, so it cannot drift from what a mandate will actually accept.
 */
export function TokenAddresses({ options }: { options: StablecoinOption[] }) {
  // Keyed by mint: copying one token must not report success under another.
  const [status, setStatus] = useState<{ mint: string; message: string } | null>(null);

  return <section className="dashboard-card">
    <div className="owner-settings-heading">
      <span className="owner-row-icon neutral"><ReceiptText /></span>
      <div>
        <h2>Token addresses</h2>
        <p>The mint address identifies a token when you set up a payment.</p>
      </div>
    </div>
    {options.length === 0
      ? <p className="owner-caption">No enabled registry assets have loaded yet.</p>
      : options.map((option) => {
        const copied = status?.mint === option.mint && status.message === "Copied";
        return <div className="owner-settings-row owner-mcp-settings" key={option.mint}>
          <div>
            <div className="owner-token-heading"><TokenIcon mint={option.mint} /><strong>{option.label}</strong></div>
            <p>{option.detail}</p>
            <code className="owner-mcp-endpoint">{option.mint}</code>
            {status?.mint === option.mint && <p role="status">{status.message}</p>}
          </div>
          <div className="owner-mcp-actions">
            <Button
              label={copied ? "Copied" : `Copy ${option.label} address`}
              variant="secondary"
              icon={<Copy size={16} />}
              onClick={() => void copyValue(option.mint).then((ok) => {
                setStatus({ mint: option.mint, message: ok ? "Copied" : COPY_FAILED });
              })}
            />
          </div>
        </div>;
      })}
  </section>;
}
