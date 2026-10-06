import { useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { COMMITMENT_FIELD_LABELS, encodeDisclosureFragment, type CardView } from "@chainpayhq/sdk";
import type { CardsSource } from "./source";
import { errorText } from "./shared";

/** Fields an owner may pick. Field 0 (the card itself) travels in every link. */
export const SHAREABLE_FIELDS = [2, 3, 4, 9, 10, 11, 12, 13, 14, 7, 8, 1, 5, 6, 15];

export function cardShareUrl(origin: string, fragment: string): string {
  return `${origin.replace(/\/$/, "")}/verify/card#${fragment}`;
}

/** Explicit field picker (ruling K15). Nothing is pre-checked; the link carries only the picked fields. */
export function CardSharePicker({ source, card, open, onClose }: { source: CardsSource; card: CardView; open: boolean; onClose: () => void }) {
  const [picked, setPicked] = useState<number[]>([]);
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  function close() {
    setPicked([]);
    setLink("");
    setError("");
    setCopied(false);
    onClose();
  }

  async function create() {
    setBusy(true);
    setError("");
    try {
      const bundle = await source.disclose(card, picked);
      setLink(cardShareUrl(window.location.origin, encodeDisclosureFragment(bundle)));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <Dialog isOpen={open} onOpenChange={(next) => { if (!next) close(); }} purpose="form" width={520}>
      <Layout
        height="auto"
        header={<DialogHeader title="Share card details" onOpenChange={(next) => { if (!next) close(); }} />}
        content={
          <LayoutContent>
            <div className="cp-share-picker" data-testid="share-picker">
              <p>Pick only what the other person needs. They can check each field against the card's public checkpoint. They don't see the fields you leave out.</p>
              <fieldset disabled={Boolean(link)}>
                <legend className="cp-visually-hidden">Fields to share</legend>
                {SHAREABLE_FIELDS.map((i) => (
                  <CheckboxInput key={i} label={COMMITMENT_FIELD_LABELS[i]} value={picked.includes(i)} onChange={(value) => setPicked((current) => value ? [...current, i] : current.filter((item) => item !== i))} />
                ))}
              </fieldset>
              <p className="cp-share-warning" role="note" data-testid="share-wallet-warning">Anyone with this link can read the fields you pick. The link also names this card's public account on Solana, and that account shows your wallet address, so they can look up your wallet and its public activity.</p>
              <p className="owner-muted cp-share-expiry">Links check against the card's latest public checkpoint, so a link stops checking once the card changes and a new checkpoint is written (at most every 15 minutes while it's in use). Make a fresh link when you need one.</p>
              {link && (
                <div className="cp-share-link" data-testid="share-link">
                  <label htmlFor="cp-share-link-input">Link</label>
                  <input id="cp-share-link-input" className="mono" readOnly value={link} onFocus={(event) => event.currentTarget.select()} />
                  <small>The details live after the “#”, so they never reach a server.</small>
                </div>
              )}
              {error && <div className="builder-error" role="alert"><b>Couldn't make the link</b><span>{error}</span></div>}
            </div>
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <div className="cp-dialog-footer">
            <Button type="button" variant="secondary" label={link ? "Done" : "Cancel"} onClick={close} />
            {link
              ? <Button type="button" variant="primary" label={copied ? "Copied" : "Copy link"} onClick={() => void copy()} />
              : <Button type="button" variant="primary" label={busy ? "Making link…" : `Make link${picked.length ? ` (${picked.length})` : ""}`} isDisabled={busy || picked.length === 0} onClick={() => void create()} />}
          </div></LayoutFooter>
        }
      />
    </Dialog>
  );
}
