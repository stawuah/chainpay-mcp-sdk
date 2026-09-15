import type { ChainPayWallet } from "./wallet";

let wallet: ChainPayWallet | null = null;
let backend = "";
let allowedOrigins = new Set<string>();
let session: { token: string; expires_at_ms: number; wallet: string } | null = null;
let pending: Promise<void> | null = null;
let generation = 0;

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
  if (previous) void fetch(`${backend}/v1/auth/session`, { method: "DELETE", headers: { Authorization: `Bearer ${previous.token}` } }).catch(() => undefined);
}
async function signIn() {
  const signer = wallet;
  const revision = generation;
  if (!signer?.signMessage) throw new Error("This wallet must support message signing to sign in. Login does not authorize a payment.");
  const response = await fetch(`${backend}/v1/auth/challenge?wallet=${encodeURIComponent(signer.address)}`, { method: "POST" });
  if (!response.ok) throw new Error("Could not create a wallet login challenge. Try again shortly.");
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
}
export async function authorizedFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const url = new URL(input, location.href);
  if (!allowedOrigins.has(url.origin)) throw new Error("Refusing to send a wallet session to another service");
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
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${active.token}`);
  const revision = generation;
  const response = await fetch(input, { ...init, headers });
  if (revision !== generation || wallet?.address !== active.wallet) throw new Error("Wallet changed while the request was pending. Refresh with the intended wallet.");
  if (response.status === 401 && session === active) session = null;
  return response;
}
