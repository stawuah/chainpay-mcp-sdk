import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Transaction } from "@solana/web3.js";
import type { CardSection } from "../../routing/paths";
import { cardsSourceOverride, type CardsSource } from "./source";
import { createLiveCardsSource } from "./liveSource";
import { CardList } from "./CardList";
import { CardCreate } from "./CardCreate";
import { CardDetail } from "./CardDetail";
import { IllustrativeBanner } from "./ui";
import type { CardsNavigate, CardsShared } from "./shared";
import "./cards.css";

export type { CardsNavigate };


export type CardsAreaProps = {
  wallet: string;
  walletSigner?: (transaction: Transaction) => Promise<Transaction>;
  walletMessageSigner?: (message: Uint8Array) => Promise<Uint8Array>;
  onCallMcp: (name: string, args: Record<string, unknown>) => Promise<{ isError?: boolean; structuredContent?: unknown }>;
  /** Spending permissions this wallet owns, for statement repayment. */
  mandates: { address: string; approvedAgent: string; allowedMint: string; status: string }[];
  cardsNew?: boolean;
  cardId?: string;
  cardSection?: CardSection;
  onNavigate: CardsNavigate;
  /** Dashboard-level notice (the sign-in strip), shown under the page header. */
  notice?: ReactNode;
};

/** Cards area (design ruling 2026-10-04). Picks the live or fixture source once per wallet. */
export function CardsArea(props: CardsAreaProps) {
  // Latest signer/adapters, read on every call so a late-attaching or reconnected wallet is never stale.
  const deps = useRef({ wallet: props.wallet, signTransaction: props.walletSigner, signMessage: props.walletMessageSigner, onCallMcp: props.onCallMcp });
  deps.current = { wallet: props.wallet, signTransaction: props.walletSigner, signMessage: props.walletMessageSigner, onCallMcp: props.onCallMcp };
  const source: CardsSource = useMemo(
    () => cardsSourceOverride() ?? createLiveCardsSource(() => deps.current),
    // The source owns the private session; recreate only for a different wallet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.wallet],
  );
  const [unlocked, setUnlocked] = useState(() => source.isUnlocked());
  useEffect(() => setUnlocked(source.isUnlocked()), [source]);

  const notice = (props.notice || source.mode === "fixture") ? <>{props.notice}{source.mode === "fixture" && <IllustrativeBanner />}</> : undefined;
  const shared: CardsShared = { source, unlocked, onUnlocked: () => setUnlocked(true), onNavigate: props.onNavigate, notice };
  return (
    <div className="cp-cards" data-cards-mode={source.mode}>
      {props.cardsNew ? (
        <CardCreate {...shared} />
      ) : props.cardId ? (
        <CardDetail {...shared} cardId={props.cardId} section={props.cardSection ?? "activity"} wallet={props.wallet} mandates={props.mandates} />
      ) : (
        <CardList {...shared} />
      )}
    </div>
  );
}

export default CardsArea;
