import type { ReactNode } from "react";
import { CircleX, Inbox, LogIn, TriangleAlert, type LucideIcon } from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import type { CollectionStateKind } from "./collectionModel";

export type { CollectionStateKind } from "./collectionModel";

/*
  Renders the non-loaded states of a collection with one shared shape, and the
  loaded content otherwise. A partial collection shows a notice above what did
  load. Every state names what happened in plain words; none of them reads as
  zero or "all clear".
*/
export type CollectionStateProps = {
  state: CollectionStateKind;
  /** What the collection holds, lower case: "agents", "payments". Used in default copy. */
  noun: string;
  title?: ReactNode;
  description?: ReactNode;
  /** Primary action for empty or signed-out states (one per state). */
  action?: ReactNode;
  onRetry?: () => void;
  retryLabel?: string;
  icon?: LucideIcon;
  /** Number of skeleton rows while loading. */
  rows?: number;
  compact?: boolean;
  children?: ReactNode;
};

const DEFAULT_TITLES: Record<Exclude<CollectionStateKind, "loaded">, (noun: string) => string> = {
  "signed-out": (noun) => `Sign in to see your ${noun}`,
  loading: (noun) => `Loading ${noun}…`,
  empty: (noun) => `No ${noun} yet`,
  partial: (noun) => `Some ${noun} couldn’t be loaded`,
  failed: (noun) => `Couldn’t load your ${noun}`,
};

export function CollectionState({ state, noun, title, description, action, onRetry, retryLabel = "Try again", icon, rows = 3, compact = false, children }: CollectionStateProps) {
  if (state === "loaded") return <>{children}</>;
  const heading = title ?? DEFAULT_TITLES[state](noun);
  const retry = onRetry ? <Button type="button" variant="secondary" label={retryLabel} onClick={onRetry} /> : null;

  if (state === "loading") {
    return (
      <div className={`cp-collection-state is-loading${compact ? " is-compact" : ""}`} data-state="loading" aria-busy="true">
        <span className="sr-only" role="status">{heading}</span>
        {Array.from({ length: rows }, (_, index) => <Skeleton key={index} width="100%" height={compact ? 20 : 44} />)}
      </div>
    );
  }

  if (state === "partial") {
    return (
      <>
        <div className="cp-collection-notice" data-state="partial" role="status">
          <TriangleAlert aria-hidden="true" size={16} />
          <div><strong>{heading}</strong>{description ? <p>{description}</p> : null}</div>
          {retry}
        </div>
        {children}
      </>
    );
  }

  const Icon = icon ?? (state === "signed-out" ? LogIn : state === "failed" ? CircleX : Inbox);
  return (
    <div className={`cp-collection-state${compact ? " is-compact" : ""}`} data-state={state} role={state === "failed" ? "alert" : undefined}>
      <span className="cp-collection-icon" aria-hidden="true"><Icon size={20} /></span>
      <div className="cp-collection-copy">
        <strong>{heading}</strong>
        {description ? <p>{description}</p> : null}
      </div>
      {(state === "failed" ? retry : action) ?? null}
    </div>
  );
}
