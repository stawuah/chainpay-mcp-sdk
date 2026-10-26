import { apiOrigin, client, type Principal } from "../../paypal/client";
import { PAYPAL_API_URL } from "../../config/public";
import { allowSessionExchange, authorizedFetch, sessionBinding, type WalletBinding } from "../../session";
import { PaypalNotConfiguredError, type PaypalApi, type PaypalSource } from "./source";

type Bridged = { token: string; wallet: string; expiresAt: number };

/** One in-memory PayPal session, bound to the wallet session that opened it. */
export function createLivePaypalSource(wallet: string, configured: string | undefined = PAYPAL_API_URL): PaypalSource {
  let origin: string | null = null;
  let configError: Error | null = null;
  try { origin = apiOrigin(configured); } catch (cause) { configError = cause instanceof Error ? cause : new Error(String(cause)); }
  const exchangeUrl = origin ? `${origin}/v1/paypal/session/wallet` : null;
  let releaseExchange: (() => void) | null = null;
  let binding: WalletBinding | null = null;
  let bridged: Bridged | null = null;
  let pending: Promise<Bridged> | null = null;
  let generation = 0;
  let active = false;

  function assertActive(revision = generation) {
    const current = sessionBinding();
    if (!active || revision !== generation || !binding || current.wallet !== wallet || current.wallet !== binding.wallet || current.generation !== binding.generation) throw new Error("PayPal session closed or wallet changed. Open PayPal again.");
  }

  async function exchange(): Promise<Bridged> {
    if (!exchangeUrl) throw new PaypalNotConfiguredError(configError ? `PayPal isn't set up on this site yet. ${configError.message}` : undefined);
    const revision = generation;
    assertActive(revision);
    const response = await authorizedFetch(exchangeUrl, { method: "POST", redirect: "error", credentials: "omit", cache: "no-store" }, binding!, "passive");
    if (!response.ok) {
      if (response.status === 404 || response.status === 405) throw new Error("This PayPal service doesn't do wallet sign-in yet.");
      if (response.status === 401 || response.status === 403) throw new Error("PayPal didn't accept this wallet session. Sign in again.");
      const body = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error || `PayPal is unavailable right now (${response.status}).`);
    }
    const body = await response.json() as { token?: unknown; wallet?: unknown; expires_at?: unknown };
    if (typeof body.token !== "string" || !body.token) throw new Error("PayPal answered without a session.");
    if (body.wallet !== wallet) throw new Error("PayPal opened a session for a different wallet, so it wasn't used.");
    if (typeof body.expires_at !== "number" || !Number.isSafeInteger(body.expires_at) || body.expires_at * 1000 <= Date.now() || body.expires_at * 1000 > Date.now() + 12 * 3600_000) throw new Error("PayPal answered with an invalid session expiry.");
    assertActive(revision);
    return { token: body.token, wallet: body.wallet, expiresAt: body.expires_at * 1000 };
  }

  async function token(): Promise<string> {
    const revision = generation;
    assertActive(revision);
    if (bridged && bridged.expiresAt > Date.now() + 30_000) return bridged.token;
    bridged = null;
    if (!pending) {
      const attempt = exchange();
      pending = attempt;
      void attempt.finally(() => { if (pending === attempt) pending = null; }).catch(() => undefined);
    }
    const next = await pending;
    assertActive(revision);
    bridged = next;
    return next.token;
  }

  const api: PaypalApi = async function request<T>(path: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<T> {
    const revision = generation;
    const credential = await token();
    assertActive(revision);
    const result = await client(origin!, credential)<T>(path, method, body, signal);
    assertActive(revision);
    return result;
  };

  return {
    mode: "live",
    async connect() {
      if (!exchangeUrl) throw new PaypalNotConfiguredError(configError?.message);
      if (!active) {
        binding = sessionBinding();
        if (binding.wallet !== wallet) throw new Error("Connect the intended wallet before opening PayPal.");
        active = true;
        releaseExchange = allowSessionExchange(exchangeUrl);
      }
      await token();
      const principal = await api<Principal>("/session");
      if (principal.role !== "buyer" || principal.id !== wallet) throw new Error("PayPal returned a session that does not belong to this buyer.");
      return { api, principal, wallet, expiresAt: bridged?.expiresAt ?? null };
    },
    disconnect() {
      generation += 1;
      active = false;
      releaseExchange?.();
      releaseExchange = null;
      binding = null;
      bridged = null;
      pending = null;
    },
  };
}
