import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { Arrow } from "./marks";

export type WalletPickerOption = {
  id: string;
  name: string;
  icon?: string;
  standard: boolean;
};

export type WalletPickerDialogProps = {
  isOpen: boolean;
  wallets: WalletPickerOption[];
  connecting: boolean;
  error: string;
  onSelect: (optionId: string) => void;
  onOpenChange: (open: boolean) => void;
};

export function WalletPickerDialog({
  isOpen,
  wallets,
  connecting,
  error,
  onSelect,
  onOpenChange,
}: WalletPickerDialogProps) {
  return (
    <Dialog isOpen={isOpen} onOpenChange={onOpenChange} purpose="info" width={440}>
      <Layout
        height="auto"
        header={<DialogHeader title="Choose a wallet" onOpenChange={onOpenChange} />}
        content={
          <LayoutContent>
            <p>ChainPay uses Wallet Standard so you choose the wallet and account that signs. No wallet is selected automatically.</p>
            <div className="wallet-picker-list">
              {wallets.map((option) => (
                <Button
                  key={option.id}
                  type="button"
                  variant="secondary"
                  label={option.name}
                  isDisabled={connecting}
                  width="100%"
                  className="wallet-picker-option"
                  onClick={() => onSelect(option.id)}
                  icon={
                    <span className="wallet-picker-icon">
                      {option.icon ? <img src={option.icon} alt="" /> : option.name.slice(0, 1).toUpperCase()}
                    </span>
                  }
                  endContent={<Arrow />}
                />
              ))}
              {wallets.length === 0 && (
                <div className="wallet-picker-empty">
                  <b>No compatible Solana wallet found</b>
                  <p>Install or unlock a Wallet Standard wallet such as Phantom, Backpack, or Solflare, then reopen this list.</p>
                </div>
              )}
            </div>
            {error && (
              <div className="builder-error" role="alert">
                <b>Connection failed</b>
                <span>{error}</span>
              </div>
            )}
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <Button
              type="button"
              variant="secondary"
              label="Cancel"
              isDisabled={connecting}
              onClick={() => onOpenChange(false)}
            />
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
