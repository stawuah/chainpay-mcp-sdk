import { useEffect, useRef, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import type { CardView } from "@chainpay/sdk";
import type { CardsSource } from "./source";
import { errorText } from "./shared";

/*
 * Human-only card number display (contracts.md §3.4 embed-session, PLAN D).
 *
 * The number, expiry and CVV load straight from the card network (Lithic's
 * embedded card UI, a single-use session) into a sandboxed iframe. ChainPay's
 * page never receives them, never logs them and never renders them itself.
 * Agents can't reach this: there is no MCP tool for it and the Axum route
 * needs an owner session. The frame closes itself when the session expires.
 */

const ALLOWED_EMBED_ORIGINS = new Set(["https://sandbox.lithic.com", "https://api.lithic.com"]);
const MAX_OPEN_MS = 60_000;

/** Only a Lithic embed URL may be framed; anything else is refused instead of rendered. */
export function safeEmbedUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return ALLOWED_EMBED_ORIGINS.has(url.origin) && url.pathname.startsWith("/v1/embed") ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * `closeKey`: anything that means the owner moved on (the card section on screen).
 * The frame closes when it changes, when the browser tab is hidden or left, and on unmount.
 */
export function CardNumberReveal({ source, card, closeKey }: { source: CardsSource; card: CardView; closeKey?: string }) {
  const [state, setState] = useState<{ kind: "closed" } | { kind: "loading" } | { kind: "open"; url: string | null; closesAt: number } | { kind: "error"; message: string }>({ kind: "closed" });

  useEffect(() => {
    if (state.kind !== "open") return;
    const timer = window.setTimeout(() => setState({ kind: "closed" }), Math.max(0, state.closesAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [state]);

  // Each open() gets a token; a reply for an older request, another card or an unmounted view is dropped.
  const request = useRef(0);
  useEffect(() => {
    request.current += 1;
    setState({ kind: "closed" });
    return () => { request.current += 1; };
  }, [card.cardId, closeKey]);

  // Hidden tab or leaving the page closes the frame (and drops a reply still on its way).
  useEffect(() => {
    const close = () => { request.current += 1; setState((current) => current.kind === "closed" ? current : { kind: "closed" }); };
    const onVisibility = () => { if (document.visibilityState === "hidden") close(); };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", close);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", close);
    };
  }, []);

  async function open() {
    const mine = ++request.current;
    const current = () => request.current === mine;
    setState({ kind: "loading" });
    try {
      const session = await source.cardNumberSession(card.cardId);
      if (!current()) return;
      const expires = Date.parse(session.expiresAt);
      const closesAt = Math.min(Date.now() + MAX_OPEN_MS, Number.isFinite(expires) ? expires : Date.now() + MAX_OPEN_MS);
      if (session.embedUrl === null) {
        setState({ kind: "open", url: null, closesAt });
        return;
      }
      const url = safeEmbedUrl(session.embedUrl);
      if (!url) throw new Error("The card network sent an unexpected link, so nothing was shown.");
      setState({ kind: "open", url, closesAt });
    } catch (error) {
      if (current()) setState({ kind: "error", message: errorText(error) });
    }
  }

  return (
    <div className="cp-card-number-reveal" data-state={state.kind}>
      {state.kind === "open" ? (
        <>
          {state.url ? (
            <iframe
              className="cp-card-number-frame"
              title={`Card number for ${card.label}, from the card network`}
              src={state.url}
              sandbox="allow-scripts allow-same-origin"
              referrerPolicy="no-referrer"
              allow="clipboard-write"
            />
          ) : (
            <div className="cp-card-number-frame is-illustrative" data-testid="card-number-placeholder">
              The card network's frame shows the number here. Illustrative data has no card number.
            </div>
          )}
          <button type="button" className="cp-link-button" onClick={() => { request.current += 1; setState({ kind: "closed" }); }}><EyeOff size={14} aria-hidden="true" /> Hide card number</button>
          <small className="owner-muted">Shown in this browser only. It loads straight from the card network into this frame, ChainPay never receives it, and your agent never gets it.</small>
        </>
      ) : (
        <>
          <button type="button" className="cp-link-button" disabled={state.kind === "loading"} onClick={() => void open()}>
            <Eye size={14} aria-hidden="true" /> {state.kind === "loading" ? "Opening…" : "Show card number"}
          </button>
          {state.kind === "error" && <small className="cp-inline-error" role="alert">{state.message}</small>}
        </>
      )}
    </div>
  );
}
