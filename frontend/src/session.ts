import type { ChainPayWallet } from "./wallet/connect";

let wallet: ChainPayWallet | null = null;
let backend = "";
let allowedOrigins = new Set<string>();
let session: { token: string; expires_at_ms: number; wallet: string } | null = null;
let pending: Promise<void> | null = null;
let generation = 0;
const sessionListeners = new Set<() => void>();
let expiryTimer: ReturnType<typeof setTimeout> | undefined;

export function hasReadySession() {
  return Boolean(session && session.wallet === wallet?.address && session.expires_at_ms > Date.now() + 5_000);
}
function notifySession() {
  if (expiryTimer !== undefined) clearTimeout(expiryTimer);
  expiryTimer = undefined;
  for (const listener of sessionListeners) listener();
  if (sessionListeners.size && hasReadySession() && session) {
    expiryTimer = setTimeout(notifySession, Math.max(1, session.expires_at_ms - Date.now() - 5_000));
  }
}
export function subscribeSession(listener: () => void) {
  sessionListeners.add(listener);
  notifySession();
  return () => {
    sessionListeners.delete(listener);
    if (!sessionListeners.size && expiryTimer !== undefined) {
      clearTimeout(expiryTimer);
      expiryTimer = undefined;
    }
  };
}

export function configureSession(backendUrl: string, mcpUrl: string) {
  backend = backendUrl.replace(/\/$/, "");
  allowedOrigins = new Set([new URL(backendUrl, location.href).origin, new URL(mcpUrl, location.href).origin]);
}
export function setSessionWallet(next: ChainPayWallet | null) {
  const previous = session;
  generation++;
  wallet = next;
  session = null;
  pending = null;
  notifySession();
  if (previous) void fetch(`${backend}/v1/auth/session`, { method: "DELETE", headers: { Authorization: `Bearer ${previous.token}` } }).catch(() => undefined);
}
async function signIn() {
  const signer = wallet;
  const revision = generation;
  if (!signer?.signMessage) throw new Error("This wallet must support message signing to sign in. Login does not authorize a payment.");
  const response = await fetch(`${backend}/v1/auth/challenge?wallet=${encodeURIComponent(signer.address)}`, { method: "POST" });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error("The sign-in service rejected this dashboard’s access. Its deployment or allowed website addresses need to be updated. Changing wallets will not resolve this.");
    }
    if (response.status === 404 || response.status === 405) {
      throw new Error("This backend does not support the current wallet sign-in flow. The sign-in service needs to be updated.");
    }
    if (response.status === 429) throw new Error("Too many sign-in attempts. Wait a minute before trying again.");
    throw new Error("The sign-in service is temporarily unavailable. Try again shortly.");
  }
  const challenge = await response.json() as { challenge_id: string; message: string };
  const signature = await signer.signMessage(new TextEncoder().encode(challenge.message));
  if (generation !== revision) throw new Error("Wallet changed during sign in. Try again with the current wallet.");
  const login = await fetch(`${backend}/v1/auth/session`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ challenge_id: challenge.challenge_id, signature: btoa(String.fromCharCode(...signature)) }),
  });
  if (!login.ok) throw new Error("Wallet login failed. Sign in again.");
  const result = await login.json() as NonNullable<typeof session>;
  if (generation !== revision || result.wallet !== signer.address) {
    await fetch(`${backend}/v1/auth/session`, { method: "DELETE", headers: { Authorization: `Bearer ${result.token}` } }).catch(() => undefined);
    throw new Error("Wallet changed during sign in");
  }
  session = result;
  notifySession();
}
export async function authorizedFetch(input: string, init: RequestInit = {}, expected?: WalletBinding, mode: "interactive" | "passive" = "interactive"): Promise<Response> {
  const url = new URL(input, location.href);
  if (!allowedOrigins.has(url.origin)) throw new Error("Refusing to send a wallet session to another service");
  let active: NonNullable<typeof session>;
  try {
    if (mode === "passive") {
      if (!hasReadySession() || !session) throw new Error("Sign in to refresh this workspace.");
      active = session;
    } else active = await ensureSessionReady();
  } catch (error) { throw new RequestNotSentError(error instanceof Error ? error.message : String(error)); }
  if (expected && (expected.wallet !== active.wallet || expected.generation !== generation)) throw new RequestNotSentError("Wallet changed before submission; request was not sent");
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${active.token}`);
  const revision = generation;
  const response = await fetch(input, { ...init, headers });
  if (revision !== generation || wallet?.address !== active.wallet) throw new Error("Wallet changed while the request was pending. Refresh with the intended wallet.");
  if (response.status === 401 && session === active) { session = null; notifySession(); }
  return response;
}

export function sessionWalletAddress(): string | null { return wallet?.address ?? null; }

export class RequestNotSentError extends Error {}
export async function ensureSessionReady() {
  if (!session || session.expires_at_ms <= Date.now() + 5_000) {
    if (!pending) {
      const attempt = signIn();
      pending = attempt;
      void attempt.finally(() => { if (pending === attempt) pending = null; }).catch(() => undefined);
    }
    await pending;
  }
  const active = session;
  if (!active || active.wallet !== wallet?.address) throw new Error("Sign in with your current wallet");
  return active;
}

export type WalletBinding = { wallet: string; generation: number };
export function sessionBinding(): WalletBinding {
  if (!wallet) throw new RequestNotSentError("Connect the original wallet");
  return { wallet: wallet.address, generation };
}
