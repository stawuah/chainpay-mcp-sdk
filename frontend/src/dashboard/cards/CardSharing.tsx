import { useState } from "react";
import { SectionHeader } from "../../ui/workspace/SectionHeader";
import { PublicKey } from "@solana/web3.js";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { TextInput } from "@astryxdesign/core/TextInput";
import { ShieldCheck, UserPlus } from "lucide-react";
import type { CardView } from "@chainpay/sdk";
import type { CardPrivateRead, CardsSource } from "./source";
import { errorText } from "./shared";
import { UnlockStrip } from "./Unlock";
import { CardSharePicker } from "./CardSharePicker";

/** Owner + ChainPay's approver + up to 4 readers (contracts §1.2 MAX_MEMBERS = 6). */
export const MAX_READERS = 4;

const ROLE_COPY = {
  owner: { title: "You", detail: "Full control. Only you can change limits, add readers or unfreeze." },
  approver: { title: "ChainPay approver", detail: "Checks each purchase against your limits. It can freeze the card for safety but can't change your rules." },
  reader: { title: "Reader", detail: "Can see limits and activity. Can't spend, change rules or unfreeze." },
} as const;

export function CardSharing({ source, card, read, unlocked, onUnlocked, onChanged }: { source: CardsSource; card: CardView; read: CardPrivateRead | undefined; unlocked: boolean; onUnlocked: () => void; onChanged: () => void }) {
  const [adding, setAdding] = useState(false);
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [sharing, setSharing] = useState(false);
  const members = source.members(card, read);
  const readers = members.filter((member) => member.role === "reader");

  function addressProblem(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) return "Paste a Solana wallet address.";
    try { new PublicKey(trimmed); } catch { return "That isn't a Solana wallet address."; }
    if (members.some((member) => member.pubkey === trimmed)) return "That wallet can already read this card.";
    return "";
  }

  async function add() {
    const problem = addressProblem(address);
    if (problem) { setError(problem); return; }
    setBusy("add");
    setError("");
    try {
      await source.addReader(card, address.trim());
      setAdding(false);
      setAddress("");
      onChanged();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy("");
    }
  }

  async function remove(pubkey: string) {
    setBusy(pubkey);
    setError("");
    try {
      await source.removeReader(card, pubkey);
      onChanged();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy("");
    }
  }

  return (
    <section className="cp-sharing" data-testid="card-sharing">
      <div className="cp-surface cp-cards-surface">
        <SectionHeader
          title="Who can read this card"
          action={<Button type="button" variant="primary" label="Add a reader" icon={<UserPlus size={16} />} isDisabled={!unlocked || readers.length >= MAX_READERS} onClick={() => { setError(""); setAdding(true); }} />}
        />
        {!unlocked ? (
          <UnlockStrip source={source} onUnlocked={onUnlocked} compact />
        ) : (
          <ul className="cp-members">
            {members.map((member) => (
              <li key={member.pubkey} data-role={member.role}>
                <span className="owner-row-icon neutral"><ShieldCheck size={18} /></span>
                <div><b>{ROLE_COPY[member.role].title}</b><small className="mono">{member.pubkey}</small><small>{ROLE_COPY[member.role].detail}</small></div>
                {member.role === "reader" && <Button type="button" variant="ghost" label={busy === member.pubkey ? "Waiting for wallet…" : "Remove"} isDisabled={Boolean(busy)} onClick={() => void remove(member.pubkey)} />}
              </li>
            ))}
          </ul>
        )}
        <p className="owner-muted">{readers.length} of {MAX_READERS} readers. There's no way to make a card public: its rules stay readable only by the wallets listed here.</p>
        {error && !adding && <div className="builder-error" role="alert"><b>Needs attention</b><span>{error}</span></div>}
      </div>

      <div className="cp-surface cp-cards-surface cp-share-card">
        <SectionHeader title="Share a few details" action={<Button type="button" variant="secondary" label="Pick fields to share" onClick={() => setSharing(true)} />} />
        <p>Make a link that shows only the fields you pick, like this period's charges for your accountant. Anyone can check them against the card's public checkpoint. It's an integrity check, not a zero-knowledge proof: the fields you pick are shown in the clear.</p>
      </div>

      <Dialog isOpen={adding} onOpenChange={(next) => { if (!next) setAdding(false); }} purpose="form" width={480}>
        <Layout
          height="auto"
          header={<DialogHeader title="Add a reader" onOpenChange={(next) => { if (!next) setAdding(false); }} />}
          content={
            <LayoutContent>
              <div className="cp-add-reader" data-testid="add-reader">
                <p>They can see limits and activity. They can't spend, change rules or unfreeze.</p>
                <TextInput label="Wallet address" value={address} onChange={setAddress} placeholder="Their Solana wallet address" description="They read the card by signing in with this wallet." />
                {error && <div className="builder-error" role="alert"><b>Can't add this reader</b><span>{error}</span></div>}
              </div>
            </LayoutContent>
          }
          footer={
            <LayoutFooter>
              <div className="cp-dialog-footer">
              <Button type="button" variant="secondary" label="Cancel" onClick={() => setAdding(false)} />
              <Button type="button" variant="primary" label={busy === "add" ? "Waiting for wallet…" : "Add reader"} isDisabled={Boolean(busy)} onClick={() => void add()} />
            </div></LayoutFooter>
          }
        />
      </Dialog>
      <CardSharePicker source={source} card={card} open={sharing} onClose={() => setSharing(false)} />
    </section>
  );
}
