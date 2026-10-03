import type { PetAction, PetActionResult, PetState } from "../../../../shared/pet";

export type Pending = { commandId: string; action: PetAction; token: string };
type Session = { token: string; expiresAt: number };
export type SharedView = { state: PetState | null; status: "loading" | "ready" | "offline"; pending: Pending | null; message: string };
type Options = { base: string; storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">; pendingStorage?: Pick<Storage, "getItem" | "setItem" | "removeItem">; fetcher?: typeof fetch; uuid?: () => string; now?: () => number; locks?: Pick<LockManager, "request"> };
const SESSION = "chainpay.pet.community.session";
const PENDING = "chainpay.pet.community.pending";

/** No payment session imports: an anonymous pet token is only ever sent to /pet/act. */
export function createSharedClient({ base, storage, pendingStorage, fetcher = fetch, uuid = () => crypto.randomUUID(), locks = globalThis.navigator?.locks }: Options) {
  function read<T>(key: string): T | null { try { return JSON.parse((key === PENDING ? pendingStorage : storage)?.getItem(key) ?? "null") as T | null; } catch { return null; } }
  function save(key: string, value: unknown) { try { const target = key === PENDING ? pendingStorage : storage; if (value === null) target?.removeItem(key); else target?.setItem(key, JSON.stringify(value)); } catch { /* Memory-only anonymous session. */ } }
  let session = read<Session>(SESSION);
  const saved = read<Pending>(PENDING);
  let view: SharedView = { state: null, status: "loading", pending: saved, message: saved ? "A previous action is unconfirmed. Retry it to check." : "Connecting to our community robot…" };
  const listeners = new Set<() => void>();
  let refreshing: Promise<void> | null = null;
  let acting = false;
  const update = (next: Partial<SharedView>) => { view = { ...view, ...next }; listeners.forEach((fn) => fn()); };
  const confirm = (state: PetState) => {
    if (!view.state || state.revision > view.state.revision || (state.revision === view.state.revision && state.serverTime >= view.state.serverTime)) update({ state, status: "ready" });
    else update({ status: "ready" });
  };
  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetcher(`${base.replace(/\/$/, "")}/v1/pet/${path}`, { ...init, signal: controller.signal, credentials: "omit" });
      if (!response.ok) throw Object.assign(new Error("Pet request unavailable"), { status: response.status, retryAfter: response.headers.get("Retry-After") });
      return await response.json() as T;
    } finally { clearTimeout(timeout); }
  }
  async function refresh() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try { confirm(await request<PetState>("state")); if (view.message === "Connecting to our community robot…" || view.message.includes("Reads are temporarily limited.")) update({ message: "" }); }
      catch (error) {
        if ((error as { status?: number }).status === 429) {
          const seconds = Number((error as { retryAfter?: string }).retryAfter);
          update({ status: view.state ? "ready" : "loading", message: `${view.state ? "Showing the last confirmed room." : "The room state has not loaded yet."} Reads are temporarily limited. ${Number.isFinite(seconds) && seconds > 0 ? `Try again in ${Math.ceil(seconds)} seconds.` : "Please try again shortly."}` });
        } else update({ status: "offline" });
      }
      finally { refreshing = null; }
    })();
    return refreshing;
  }
  async function send(pending: Pending) {
    update({ pending, message: "Checking with the community…" });
    save(PENDING, pending);
    try {
      const result = await request<PetActionResult>("act", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${pending.token}` }, body: JSON.stringify({ commandId: pending.commandId, action: pending.action }) });
      confirm(result.state);
      save(PENDING, null);
      update({ pending: null, message: result.outcome === "accepted" ? "Saved to our shared room." : result.outcome === "full" ? "Already topped up. This bit of fun is just for you." : result.outcome === "cooldown" ? "Still enjoying the last top-up. We can keep playing locally." : "A little affection, just here. No shared change was saved." });
    } catch (error) {
      const status = (error as { status?: number }).status;
      // Explicit rejection is conclusive; a timeout/5xx is not. Never mint a
      // fresh command after an uncertain response, even after a page reload.
      if (status === 429) {
        save(PENDING, null);
        const seconds = Number((error as { retryAfter?: string }).retryAfter);
        update({ pending: null, status: view.state ? "ready" : view.status,
          message: `The room is taking a breather. Nothing was saved. ${Number.isFinite(seconds) && seconds > 0 ? `Try again in ${Math.ceil(seconds)} seconds.` : "Please try again shortly."}` });
      } else if (status === 400 || status === 401 || status === 403 || status === 409 || status === 422) {
        save(PENDING, null);
        if (status === 401) { session = null; save(SESSION, null); }
        update({ pending: null, message: "The shared room rejected this action. Nothing new was saved by this request." });
      } else update({ status: "offline", message: "That action is unconfirmed. Your last confirmed room is still here. Retry to check." });
    }
  }
  async function act(action: PetAction) {
    if (acting || view.pending) { update({ message: "Keep playing here. Retry the unconfirmed action before saving another." }); return; }
    acting = true;
    try {
      const acquire = async () => {
        session = read<Session>(SESSION) ?? session;
        if (!session || (view.state !== null && session.expiresAt <= view.state.serverTime)) {
          session = await request<Session>("visitors", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
          save(SESSION, session);
        }
        return session;
      };
      // First-use tabs reread the shared identity only after obtaining the lock.
      const identity = locks ? await locks.request("chainpay.pet.community.session", acquire) : await acquire();
      await send({ token: identity.token, commandId: uuid(), action });
    } catch (error) {
      if ((error as { status?: number }).status === 429) {
        const seconds = Number((error as { retryAfter?: string }).retryAfter);
        update({ message: `The room is taking a breather. This action wasn't sent. ${Number.isFinite(seconds) && seconds > 0 ? `Try again in ${Math.ceil(seconds)} seconds.` : "Please try again shortly."}` });
      } else update({ status: "offline", message: "We couldn't reach the room. You can still play here; this action wasn't sent." });
    }
    finally { acting = false; }
  }
  async function retry() {
    if (acting || !view.pending) return;
    acting = true;
    try { await send(view.pending); } finally { acting = false; }
  }
  return { get: () => view, subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; }, refresh, act, retry, request };
}
