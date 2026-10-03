import type { ReactNode } from "react";
import type { CardSection } from "../../routing/paths";
import type { CardsSource } from "./source";

export type CardsNavigate = (target: { cardsNew?: boolean; cardId?: string; cardSection?: CardSection }) => void;

export type CardsShared = {
  source: CardsSource;
  unlocked: boolean;
  onUnlocked: () => void;
  onNavigate: CardsNavigate;
  /** Notices that sit right under the page header (sign-in, illustrative data). */
  notice?: ReactNode;
};

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
