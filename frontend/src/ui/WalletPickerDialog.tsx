import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { WalletChoices } from "./WalletChoices";

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
  onRefresh: () => void;
};

export function WalletPickerDialog({
  isOpen,
  wallets,
  connecting,
  error,
  onSelect,
  onOpenChange,
  onRefresh,
}: WalletPickerDialogProps) {
  return (
    <Dialog isOpen={isOpen} onOpenChange={onOpenChange} purpose="info" width={440}>
      <Layout
        height="auto"
        header={<DialogHeader title="Choose a wallet" onOpenChange={onOpenChange} />}
        content={
          <LayoutContent>
            <p>Choose the wallet you want to use. Connecting does not authorize spending.</p>
            <WalletChoices wallets={wallets} connecting={connecting} error={error} onSelect={onSelect} onRefresh={onRefresh} />
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
