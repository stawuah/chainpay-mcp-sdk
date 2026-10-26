import { apiOrigin, client, type Principal } from "../../paypal/client";
import { PAYPAL_API_URL } from "../../config/public";
import { allowSessionExchange, authorizedFetch } from "../../session";
import { PaypalNotConfiguredError, type PaypalApi, type PaypalSource } from "./source";

type Bridged = { token: string; wallet: string; expiresAt: number | null };

const toMs = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? (value > 1e12 ? value : value * 1000) : null;

/**
 * Live PayPal source for one wallet. The wallet session (relay bearer) goes to
 * exactly one URL, `POST <origin>/v1/paypal/session/wallet`, which answers with a
 * PayPal-service session for that wallet as Buyer. That token lives in this
 * closure only: never localStorage, sessionStorage, a cookie or the URL.
 */
export function createLivePaypalSource(wallet: string, configured: string | undefined = PAYPAL_API_URL): PaypalSource {
  let origin: string | null = null;
  let configError: Error | null = null;
  try { origin = apiOrigin(configured); } catch (cause) { configError = cause instanceof Error ? cause : new Error(String(cause)); }
  const exchangeUrl = origin ? `${origin}/v1/paypal/session/wallet` : null;
  if (exchangeUrl) allowSessionExchange(exchangeUrl);

  let bridged: Bridged | null = null;
  let pending: Promise<Bridged> | null = null;
  let principal: Principal | null = null;
  let generation = 0;

  async function exchange(): Promise<Bridged> {
    if (!exchangeUrl) throw new PaypalNotConfiguredError(configError ? `PayPal isn't set up on this site yet. ${configError.message}` : undefined);
    const revision = generation;
    const response = await authorizedFetch(exchangeUrl, { method: "POST", redirect: "error", credentials: "omit", cache: "no-store" });
    if (!response.ok) {
      if (response.status === 404 || response.status === 405) throw new Error("This PayPal service doesn't do wallet sign-in yet.");
      if (response.status === 401 || response.status === 403) throw new Error("PayPal didn't accept this wallet session. Sign in again.");
      const body = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error || `PayPal is unavailable right now (${response.status}).`);
    }
    const body = await response.json() as { token?: unknown; wallet?: unknown; expires_at?: unknown };
    if (typeof body.token !== "string" || !body.token) throw new Error("PayPal answered without a session.");
    if (body.wallet !== wallet) throw new Error("PayPal opened a session for a different wallet, so it wasn't used.");
    if (revision !== generation) throw new Error("Disconnected while PayPal was answering.");
    return { token: body.token, wallet: body.wallet, expiresAt: toMs(body.expires_at) };
  }

  async function token(): Promise<string> {
    if (bridged && (bridged.expiresAt === null || bridged.expiresAt > Date.now() + 30_000)) return bridged.token;
    bridged = null;
    if (!pending) {
      const attempt = exchange();
      pending = attempt;
      void attempt.finally(() => { if (pending === attempt) pending = null; }).catch(() => undefined);
    }
    bridged = await pending;
    return bridged.token;
  }

  const api: PaypalApi = async function request<T>(path: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<T> {
    // Disputes are merchant records on the PayPal service; a buyer session is refused there.
    // A buyer sees none until the service shares them, rather than an error banner.
    if (path === "/disputes" && method === "GET" && principal && principal.role !== "merchant") return { disputes: [] } as T;
    return client(origin!, await token())<T>(path, method, body, signal);
  };

  return {
    mode: "live",
    async connect() {
      await token();
      principal = await api<Principal>("/session");
      return { api, principal, wallet: bridged?.wallet ?? wallet, expiresAt: bridged?.expiresAt ?? null };
    },
    disconnect() {
      generation += 1;
      bridged = null;
      pending = null;
      principal = null;
    },
  };
}
