import { PublicKey } from "@solana/web3.js";
import type { Address } from "../types.js";
import { DEVNET_TEE_URL } from "./constants.js";
import {
  decodeCardPeriod,
  decodeCardPolicy,
  decodeCheckoutIntent,
  decodeReservation,
  type CardPeriod,
  type CardPolicy,
  type CheckoutIntent,
  type Reservation,
} from "./accounts.js";
import { availableCents, centsToString, maxObligationCents } from "./math.js";

/*
 * MagicBlock Private Ephemeral Rollup access (contracts.md §2, CD-4, CD-6).
 *
 * - Each party gets its own token through a wallet-signed challenge. Tokens
 *   are secrets: never logged, never in errors, never serialized.
 * - A permissioned read that comes back `value: null` means "not visible to
 *   you". It is indistinguishable from "does not exist" on the wire, so it
 *   is never reported as missing.
 * - `verifyTeeRpcIntegrity` proves genuine TDX hardware, not which code runs.
 *   Until MagicBlock publishes MRTD/RTMR values the result says "hardware
 *   verified, measurements pending".
 */

const DAY_MS = 86_400_000;
const SESSION_FALLBACK_MS = 30 * DAY_MS;
const REFRESH_WINDOW_MS = DAY_MS;

// ------------------------------------------------------------------ signers

export type SignMessageWallet = {
  publicKey: Address;
  signMessage(message: Uint8Array): Promise<Uint8Array>;
};

/** Anything shaped like a Solana wallet adapter or wallet-standard account with signMessage. */
export type WalletAdapterLike = {
  publicKey: { toBase58(): string } | string | null | undefined;
  signMessage?: (message: Uint8Array) => Promise<Uint8Array | { signature: Uint8Array } | Array<{ signature: Uint8Array }>>;
};

const ED25519_PKCS8_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

/** Signer for a server keypair (Axum authorizer, scripts). The secret stays in this closure. */
export async function keypairSigner(secretKey: Uint8Array): Promise<SignMessageWallet> {
  if (secretKey.length !== 64) throw new Error("Expected a 64-byte Solana secret key");
  const seed = secretKey.slice(0, 32);
  const publicKey = new PublicKey(secretKey.slice(32)).toBase58();
  const pkcs8 = new Uint8Array(ED25519_PKCS8_PREFIX.length + 32);
  pkcs8.set(ED25519_PKCS8_PREFIX);
  pkcs8.set(seed, ED25519_PKCS8_PREFIX.length);
  const key = await globalThis.crypto.subtle.importKey("pkcs8", pkcs8.buffer, { name: "Ed25519" }, false, ["sign"]);
  pkcs8.fill(0);
  seed.fill(0);
  return {
    publicKey,
    async signMessage(message: Uint8Array) {
      return new Uint8Array(await globalThis.crypto.subtle.sign("Ed25519", key, message.slice().buffer as ArrayBuffer));
    },
  };
}

/** Signer for a browser wallet (Phantom via wallet adapter, or wallet-standard). */
export function walletAdapterSigner(adapter: WalletAdapterLike): SignMessageWallet {
  const raw = adapter.publicKey;
  if (!raw) throw new Error("Connect a wallet first");
  const publicKey = new PublicKey(typeof raw === "string" ? raw : raw.toBase58()).toBase58();
  if (typeof adapter.signMessage !== "function") throw new Error("This wallet can't sign messages, so it can't open a private card session");
  const sign = adapter.signMessage.bind(adapter);
  return {
    publicKey,
    async signMessage(message: Uint8Array) {
      const result = await sign(message);
      const signature = result instanceof Uint8Array ? result : Array.isArray(result) ? result[0]?.signature : result?.signature;
      if (!(signature instanceof Uint8Array) || signature.length !== 64) throw new Error("Wallet returned an invalid signature");
      return new Uint8Array(signature);
    },
  };
}

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Encode(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let out = "";
  while (value > 0n) {
    out = BASE58[Number(value % 58n)] + out;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = "1" + out;
  }
  return out;
}

async function verifyEd25519(publicKey: Address, message: Uint8Array, signature: Uint8Array): Promise<boolean> {
  try {
    const key = await globalThis.crypto.subtle.importKey("raw", new PublicKey(publicKey).toBytes().slice().buffer as ArrayBuffer, { name: "Ed25519" }, false, ["verify"]);
    return await globalThis.crypto.subtle.verify("Ed25519", key, signature.slice().buffer as ArrayBuffer, message.slice().buffer as ArrayBuffer);
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ session

export type TeeSessionOptions = {
  teeUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
};

export class TeeAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TeeAuthError";
  }
}

type TokenGrant = { token: string; expiresAt: number };

async function acquireToken(wallet: SignMessageWallet, teeUrl: string, fetchImpl: typeof fetch, now: number, timeoutMs: number): Promise<TokenGrant> {
  let challenge: string;
  try {
    const response = await fetchImpl(`${teeUrl}/auth/challenge?${new URLSearchParams({ pubkey: wallet.publicKey })}`, { signal: AbortSignal.timeout(timeoutMs) });
    const body = await response.json() as { challenge?: unknown; error?: unknown };
    if (typeof body.error === "string" && body.error) throw new TeeAuthError("The private rollup refused to issue a sign-in challenge");
    if (typeof body.challenge !== "string" || !body.challenge) throw new TeeAuthError("The private rollup sent no sign-in challenge");
    challenge = body.challenge;
  } catch (error) {
    if (error instanceof TeeAuthError) throw error;
    throw new TeeAuthError("Couldn't reach the private rollup to sign in");
  }
  const message = new TextEncoder().encode(challenge);
  const signature = await wallet.signMessage(message);
  if (signature.length !== 64 || !await verifyEd25519(wallet.publicKey, message, signature)) {
    throw new TeeAuthError("The wallet's signature doesn't match its address");
  }
  let response: Response;
  try {
    response = await fetchImpl(`${teeUrl}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pubkey: wallet.publicKey, challenge, signature: base58Encode(signature) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new TeeAuthError("Couldn't reach the private rollup to sign in");
  }
  const body = await response.json().catch(() => ({})) as { token?: unknown; expiresAt?: unknown };
  if (response.status !== 200) throw new TeeAuthError("The private rollup rejected the sign-in");
  if (typeof body.token !== "string" || !body.token) throw new TeeAuthError("The private rollup returned no session");
  const expiresAt = typeof body.expiresAt === "number" && Number.isFinite(body.expiresAt) ? body.expiresAt : now + SESSION_FALLBACK_MS;
  return { token: body.token, expiresAt };
}

/**
 * One wallet's authenticated connection to the private rollup. Refreshes the
 * token when it is within 24 h of expiry or after any 401. The token is held
 * in a private field and never leaves this object except through
 * `endpoint()`, which exists only to build a Connection for sending
 * owner-signed transactions.
 */
export class TeeSession {
  readonly wallet: Address;
  readonly teeUrl: string;
  #grant: TokenGrant;
  readonly #signer: SignMessageWallet;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #timeoutMs: number;
  #refreshing: Promise<void> | null = null;

  private constructor(signer: SignMessageWallet, grant: TokenGrant, teeUrl: string, fetchImpl: typeof fetch, now: () => number, timeoutMs: number) {
    this.wallet = signer.publicKey;
    this.teeUrl = teeUrl;
    this.#grant = grant;
    this.#signer = signer;
    this.#fetch = fetchImpl;
    this.#now = now;
    this.#timeoutMs = timeoutMs;
  }

  static async open(signer: SignMessageWallet, options: TeeSessionOptions = {}): Promise<TeeSession> {
    const teeUrl = (options.teeUrl ?? DEVNET_TEE_URL).replace(/\/+$/, "");
    const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    const now = options.now ?? Date.now;
    const timeoutMs = options.timeoutMs ?? 15_000;
    const grant = await acquireToken(signer, teeUrl, fetchImpl, now(), timeoutMs);
    return new TeeSession(signer, grant, teeUrl, fetchImpl, now, timeoutMs);
  }

  get expiresAt(): number {
    return this.#grant.expiresAt;
  }

  needsRefresh(): boolean {
    return this.#grant.expiresAt - this.#now() < REFRESH_WINDOW_MS;
  }

  async refresh(): Promise<void> {
    if (!this.#refreshing) {
      this.#refreshing = acquireToken(this.#signer, this.teeUrl, this.#fetch, this.#now(), this.#timeoutMs)
        .then((grant) => { this.#grant = grant; })
        .finally(() => { this.#refreshing = null; });
    }
    return this.#refreshing;
  }

  async ensureFresh(): Promise<void> {
    if (this.needsRefresh()) await this.refresh();
  }

  /** SECRET: the tokenized RPC URL. Use only to construct a Connection; never log or display it. */
  async endpoint(): Promise<string> {
    await this.ensureFresh();
    return `${this.teeUrl}?token=${encodeURIComponent(this.#grant.token)}`;
  }

  /** Raw JSON-RPC over the session. Retries once after a 401 with a fresh token. */
  async rpc(method: string, params: unknown[]): Promise<{ httpStatus: number; body: unknown }> {
    await this.ensureFresh();
    const send = async () => {
      try {
        return await this.#fetch(`${this.teeUrl}?token=${encodeURIComponent(this.#grant.token)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal: AbortSignal.timeout(this.#timeoutMs),
        });
      } catch {
        // Never rethrow the platform error: it can carry the tokenized URL.
        return null;
      }
    };
    let response = await send();
    if (response?.status === 401) {
      await this.refresh();
      response = await send();
    }
    if (!response) return { httpStatus: 0, body: null };
    const body = await response.json().catch(() => null);
    return { httpStatus: response.status, body };
  }

  toJSON() {
    return { wallet: this.wallet, teeUrl: this.teeUrl, expiresAt: this.#grant.expiresAt, token: "[redacted]" };
  }

  [Symbol.for("nodejs.util.inspect.custom")]() {
    return `TeeSession(${this.wallet}, token [redacted])`;
  }
}

/** Contract name (§10): open a TEE session for a keypair- or wallet-backed signer. */
export function getTeeSession(wallet: SignMessageWallet, options?: TeeSessionOptions): Promise<TeeSession> {
  return TeeSession.open(wallet, options);
}

// -------------------------------------------------------------------- reads

export type TeeRawAccount = { owner: Address; lamports: bigint; data: Uint8Array; executable: boolean };

/**
 * `not_visible` is NOT "missing". The rollup answers a private account the
 * caller may not read exactly like an account that doesn't exist.
 */
export type TeeRead<T> =
  | { state: "visible"; account: T; slot: bigint }
  | { state: "not_visible"; slot: bigint | null }
  | { state: "rpc_error"; code: string };

export type TeeReadCommitment = "processed" | "confirmed" | "finalized";

function slotOf(body: { result?: { context?: { slot?: unknown } } }): bigint | null {
  const slot = body.result?.context?.slot;
  return typeof slot === "number" && Number.isSafeInteger(slot) ? BigInt(slot) : null;
}

function base64Bytes(value: string): Uint8Array {
  const binary = globalThis.atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export async function readTeeAccount(session: TeeSession, address: Address, commitment: TeeReadCommitment = "confirmed"): Promise<TeeRead<TeeRawAccount>> {
  const target = new PublicKey(address).toBase58();
  const { httpStatus, body } = await session.rpc("getAccountInfo", [target, { encoding: "base64", commitment }]);
  if (httpStatus === 0) return { state: "rpc_error", code: "network" };
  if (httpStatus !== 200) return { state: "rpc_error", code: `http_${httpStatus}` };
  const json = (body ?? {}) as { error?: { code?: unknown }; result?: { context?: { slot?: unknown }; value?: unknown } };
  if (json.error) return { state: "rpc_error", code: `rpc_${typeof json.error.code === "number" ? json.error.code : "error"}` };
  if (!json.result || typeof json.result !== "object") return { state: "rpc_error", code: "malformed_response" };
  const value = json.result.value as null | { owner?: unknown; lamports?: unknown; data?: unknown; executable?: unknown };
  const slot = slotOf(json as { result?: { context?: { slot?: unknown } } });
  if (value === null || value === undefined) return { state: "not_visible", slot };
  if (typeof value.owner !== "string" || !Array.isArray(value.data) || typeof value.data[0] !== "string" || typeof value.lamports !== "number") {
    return { state: "rpc_error", code: "malformed_account" };
  }
  return {
    state: "visible",
    slot: slot ?? 0n,
    account: { owner: value.owner, lamports: BigInt(value.lamports), data: base64Bytes(value.data[0]), executable: value.executable === true },
  };
}

async function readDecoded<T>(session: TeeSession, address: Address, programId: Address | undefined, decode: (data: Uint8Array) => T): Promise<TeeRead<T>> {
  const read = await readTeeAccount(session, address);
  if (read.state !== "visible") return read;
  if (programId && read.account.owner !== programId) return { state: "rpc_error", code: "wrong_owner_program" };
  try {
    return { state: "visible", slot: read.slot, account: decode(read.account.data) };
  } catch {
    return { state: "rpc_error", code: "invalid_account_data" };
  }
}

/** Display shape of a policy: cent strings, hex hashes, no bigint. */
export type CardPolicyView = {
  policyVersion: number;
  authorizer: Address;
  budgetCents: string;
  maxPurchaseCents: string;
  maxPurchasesPerPeriod: number;
  periodSeconds: number;
  currency: string;
  merchantIdHashes: string[];
  mccs: number[];
  expiresAt: string | null;
  recurringAllowed: boolean;
  feeBps: number;
  maxObligationCents: string;
  frozen: boolean;
  freezeReason: CardPolicy["freezeReason"];
  recoveryState: CardPolicy["recoveryState"];
  statementOutstandingCents: string;
  exceptionsOpen: number;
  members: Array<{ pubkey: Address; flags: number }>;
  ledgerSeq: string;
  commitSeq: string;
};

const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/** 0 = no expiry. Out-of-range seconds still render (as raw seconds) instead of throwing. */
function expiryIso(seconds: bigint): string | null {
  if (seconds === 0n) return null;
  const ms = Number(seconds) * 1000;
  return Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : `unix:${seconds.toString()}`;
}

export function cardPolicyView(policy: CardPolicy): CardPolicyView {
  return {
    policyVersion: policy.policyVersion,
    authorizer: policy.authorizer,
    budgetCents: centsToString(policy.budgetCents),
    maxPurchaseCents: centsToString(policy.maxPurchaseCents),
    maxPurchasesPerPeriod: policy.maxPurchasesPerPeriod,
    periodSeconds: policy.periodSeconds,
    currency: policy.currency,
    merchantIdHashes: policy.merchantIdHashes.map(hex),
    mccs: [...policy.mccs],
    expiresAt: expiryIso(policy.expiresAt),
    recurringAllowed: policy.recurringAllowed,
    feeBps: policy.feeBps,
    maxObligationCents: centsToString(maxObligationCents(policy.budgetCents, Math.min(policy.feeBps, 1_000))),
    frozen: policy.frozen,
    freezeReason: policy.freezeReason,
    recoveryState: policy.recoveryState,
    statementOutstandingCents: centsToString(policy.statementOutstandingCents),
    exceptionsOpen: policy.exceptionsOpen,
    members: policy.members.map((member) => ({ ...member })),
    ledgerSeq: policy.ledgerSeq.toString(),
    commitSeq: policy.commitSeq.toString(),
  };
}

export async function readCardPolicy(session: TeeSession, policyAddress: Address, programId?: Address): Promise<TeeRead<CardPolicyView>> {
  return readDecoded(session, policyAddress, programId, (data) => cardPolicyView(decodeCardPolicy(data)));
}

export function readCardPeriod(session: TeeSession, periodAddress: Address, programId?: Address): Promise<TeeRead<CardPeriod>> {
  return readDecoded(session, periodAddress, programId, decodeCardPeriod);
}

export function readReservation(session: TeeSession, address: Address, programId?: Address): Promise<TeeRead<Reservation>> {
  return readDecoded(session, address, programId, decodeReservation);
}

export function readCheckoutIntent(session: TeeSession, address: Address, programId?: Address): Promise<TeeRead<CheckoutIntent>> {
  return readDecoded(session, address, programId, decodeCheckoutIntent);
}

/** Budget left this period, only when both accounts are visible to this wallet. */
export async function readAvailableCents(session: TeeSession, accounts: { policy: Address; period: Address }, programId?: Address): Promise<TeeRead<{ availableCents: string; periodIndex: number }>> {
  const [policy, period] = await Promise.all([
    readDecoded(session, accounts.policy, programId, decodeCardPolicy),
    readCardPeriod(session, accounts.period, programId),
  ]);
  if (policy.state !== "visible") return policy;
  if (period.state !== "visible") return period;
  return {
    state: "visible",
    slot: period.slot > policy.slot ? period.slot : policy.slot,
    account: {
      availableCents: centsToString(availableCents(policy.account.budgetCents, period.account.capturedCents, period.account.reservedCents)),
      periodIndex: period.account.periodIndex,
    },
  };
}

/** Plain-language status for any read. Never says "missing" for `not_visible`. */
export function describeTeeRead(read: TeeRead<unknown>): string {
  switch (read.state) {
    case "visible":
      return "Visible to this wallet.";
    case "not_visible":
      return "Not visible to this wallet. The card's rules are private, and this wallet isn't on the list of people who can read them.";
    default:
      return `The private rollup didn't answer cleanly (${read.code}). Nothing was assumed.`;
  }
}

/** Authorizer path (CD-4): anything but a visible read means stop. */
export function requireVisible<T>(read: TeeRead<T>, what: string): T {
  if (read.state === "visible") return read.account;
  throw new Error(read.state === "not_visible" ? `${what} is not visible to this wallet; failing closed` : `${what} could not be read (${read.code}); failing closed`);
}

// -------------------------------------------------------------- attestation

export type TeeMeasurement = { mrTd: string; rtMr0: string; rtMr1: string; rtMr2: string; label?: string };

export type TeeIntegrityProvider = {
  /** Fresh-challenge quote check (genuine TDX hardware). Throws on failure. */
  verifyRpcIntegrity(teeUrl: string): Promise<void>;
  verifyIntegrity?(teeUrl: string): Promise<void>;
  /** Parse MRTD/RTMR0-2 from a fresh quote. Optional: only needed once an allowlist exists. */
  readMeasurements?(teeUrl: string): Promise<TeeMeasurement>;
};

export type AttestationMode = "report" | "enforce";

export type AttestationResult = {
  mode: AttestationMode;
  hardware: "verified" | "failed";
  measurements: "matched" | "mismatch" | "pending" | "unavailable";
  /** Whether an authorizer may keep approving purchases. */
  ok: boolean;
  label: string;
  checkedAt: string;
};

export type VerifyTeeOptions = {
  mode: AttestationMode;
  teeUrl?: string;
  /** Allowed workload measurements (current + previous). Empty or absent means "pending" (gate G-MB). */
  allowlist?: readonly TeeMeasurement[];
  provider?: TeeIntegrityProvider;
  now?: () => number;
};

const MEASUREMENT_HEX = /^[0-9a-f]{96}$/;

/** Parse `CARDS_TEE_MEASUREMENTS` (JSON list). Rejects anything that isn't 48-byte lowercase hex. */
export function parseMeasurementAllowlist(json: string | undefined): TeeMeasurement[] {
  if (!json || !json.trim()) return [];
  const parsed = JSON.parse(json) as unknown;
  if (!Array.isArray(parsed)) throw new Error("CARDS_TEE_MEASUREMENTS must be a JSON list");
  return parsed.map((entry, i) => {
    const m = entry as Partial<TeeMeasurement>;
    for (const field of ["mrTd", "rtMr0", "rtMr1", "rtMr2"] as const) {
      const value = typeof m[field] === "string" ? m[field]!.toLowerCase() : "";
      if (!MEASUREMENT_HEX.test(value)) throw new Error(`CARDS_TEE_MEASUREMENTS[${i}].${field} must be 48 bytes of hex`);
    }
    return { mrTd: m.mrTd!.toLowerCase(), rtMr0: m.rtMr0!.toLowerCase(), rtMr1: m.rtMr1!.toLowerCase(), rtMr2: m.rtMr2!.toLowerCase(), ...(m.label ? { label: String(m.label) } : {}) };
  });
}

function measurementMatches(actual: TeeMeasurement, allowed: TeeMeasurement): boolean {
  return (["mrTd", "rtMr0", "rtMr1", "rtMr2"] as const).every((field) => actual[field].toLowerCase() === allowed[field].toLowerCase());
}

/**
 * Default provider: MagicBlock's own verifiers, loaded only when installed
 * (`@magicblock-labs/ephemeral-rollups-sdk` is optional, not an SDK dependency).
 */
export async function loadMagicBlockIntegrityProvider(): Promise<TeeIntegrityProvider> {
  const specifier = "@magicblock-labs/ephemeral-rollups-sdk";
  let mod: { verifyTeeRpcIntegrity?: (url: string) => Promise<unknown>; verifyTeeIntegrity?: (url: string) => Promise<unknown> };
  try {
    mod = await import(specifier) as typeof mod;
  } catch {
    throw new Error("Install @magicblock-labs/ephemeral-rollups-sdk or pass an integrity provider to check the TEE");
  }
  if (typeof mod.verifyTeeRpcIntegrity !== "function") throw new Error("MagicBlock SDK has no verifyTeeRpcIntegrity");
  const verifyIntegrity = mod.verifyTeeIntegrity;
  return {
    verifyRpcIntegrity: async (url) => { await mod.verifyTeeRpcIntegrity!(url); },
    ...(typeof verifyIntegrity === "function" ? { verifyIntegrity: async (url: string) => { await verifyIntegrity(url); } } : {}),
  };
}

export async function verifyTee(options: VerifyTeeOptions): Promise<AttestationResult> {
  const teeUrl = (options.teeUrl ?? DEVNET_TEE_URL).replace(/\/+$/, "");
  const checkedAt = new Date((options.now ?? Date.now)()).toISOString();
  const allowlist = options.allowlist ?? [];
  const base = { mode: options.mode, checkedAt };
  let provider: TeeIntegrityProvider;
  try {
    provider = options.provider ?? await loadMagicBlockIntegrityProvider();
    await provider.verifyRpcIntegrity(teeUrl);
    if (provider.verifyIntegrity) await provider.verifyIntegrity(teeUrl);
  } catch {
    return { ...base, hardware: "failed", measurements: "unavailable", ok: false, label: "Couldn't confirm the private rollup runs on genuine secure hardware." };
  }
  if (allowlist.length === 0) {
    // Enforce without an allowlist is a misconfiguration: fail closed.
    if (options.mode === "enforce") return { ...base, hardware: "verified", measurements: "pending", ok: false, label: "Enforce mode has no measurement allowlist, so approvals are paused" };
    return { ...base, hardware: "verified", measurements: "pending", ok: true, label: "Hardware verified, measurements pending" };
  }
  let actual: TeeMeasurement;
  try {
    if (!provider.readMeasurements) throw new Error("no measurement reader");
    actual = await provider.readMeasurements(teeUrl);
  } catch {
    return {
      ...base,
      hardware: "verified",
      measurements: "unavailable",
      ok: options.mode === "report",
      label: options.mode === "report" ? "Hardware verified, measurements couldn't be read (report only)" : "Hardware verified, but the workload couldn't be checked, so approvals are paused",
    };
  }
  if (allowlist.some((allowed) => measurementMatches(actual, allowed))) {
    return { ...base, hardware: "verified", measurements: "matched", ok: true, label: "Hardware and workload verified" };
  }
  return {
    ...base,
    hardware: "verified",
    measurements: "mismatch",
    ok: options.mode === "report",
    label: options.mode === "report" ? "Hardware verified, workload doesn't match the allowlist (report only)" : "Workload doesn't match the allowlist, so approvals are paused",
  };
}
