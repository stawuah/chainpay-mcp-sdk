import { useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Copy, ReceiptText } from "lucide-react";
import { deriveAssociatedTokenAddress } from "@chainpay/sdk";
import { TokenIcon } from "../ui/TokenIcon";
import { copyValue, type StablecoinOption } from "../owner/runtime";

const COPY_FAILED = "Could not copy. Select the address to copy it manually.";

/**
 * The two addresses an owner needs for each stablecoin they can spend.
 *
 * The mint names the token and belongs in an agent or merchant configuration.
 * The token account is the only one of the two that can hold a balance, so it
 * is the one to hand out to be paid. Neither appears anywhere else in the
 * dashboard: the permission flow shows the label alone. The list is whatever
 * the registry reports as enabled, so it cannot drift from what a mandate will
 * accept, and the token account is derived from the connected wallet rather
 * than read, so it is shown whether or not it has been created yet.
 */
export function TokenAddresses({ options, wallet }: { options: StablecoinOption[]; wallet: string }) {
  // Keyed by the exact address: copying one must not report success under another.
  const [status, setStatus] = useState<{ address: string; message: string } | null>(null);

  function copyRow(address: string, key: string) {
    return {
      code: address,
      status: status?.address === key ? status.message : null,
      action: () => void copyValue(address).then((ok) => {
        setStatus({ address: key, message: ok ? "Copied" : COPY_FAILED });
      }),
      copied: status?.address === key && status.message === "Copied",
    };
  }

  return <section className="dashboard-card">
    <div className="owner-settings-heading">
      <span className="owner-row-icon neutral"><ReceiptText /></span>
      <div>
        <h2>Token addresses</h2>
        <p>Your token account receives payments in that stablecoin. The mint address names the stablecoin itself and can never receive one.</p>
      </div>
    </div>
    {options.length === 0
      ? <p className="owner-caption">No enabled registry assets have loaded yet.</p>
      : options.map((option) => {
        const tokenAccount = deriveAssociatedTokenAddress(wallet, option.mint, option.tokenProgram);
        const receive = copyRow(tokenAccount, `account:${option.mint}`);
        const mint = copyRow(option.mint, `mint:${option.mint}`);
        return <div className="owner-settings-row owner-mcp-settings" key={option.mint}>
          <div>
            <div className="owner-token-heading"><TokenIcon mint={option.mint} /><strong>{option.label}</strong></div>
            <p>{option.detail}</p>
            <p><strong>Your {option.label} account</strong> · pay this to receive {option.label}</p>
            <code className="owner-mcp-endpoint">{receive.code}</code>
            {receive.status && <p role="status">{receive.status}</p>}
            <p><strong>{option.label} mint</strong> · identifies the token, not a destination</p>
            <code className="owner-mcp-endpoint">{mint.code}</code>
            {mint.status && <p role="status">{mint.status}</p>}
          </div>
          <div className="owner-mcp-actions">
            <Button
              label={receive.copied ? "Copied" : `Copy ${option.label} account`}
              variant="secondary"
              icon={<Copy size={16} />}
              onClick={receive.action}
            />
            <Button
              label={mint.copied ? "Copied" : `Copy ${option.label} mint`}
              variant="secondary"
              icon={<Copy size={16} />}
              onClick={mint.action}
            />
          </div>
        </div>;
      })}
  </section>;
}
