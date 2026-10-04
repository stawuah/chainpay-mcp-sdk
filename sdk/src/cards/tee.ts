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
 *   `verifyTee` adds the workload check: MRTD/RTMR0-3/MROWNER of the same
 *   fresh quote against MAGICBLOCK_DEVNET_TEE_MEASUREMENTS (pinned below).
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

export type TeeMeasurement = {
  mrTd: string;
  rtMr0: string;
  rtMr1: string;
  rtMr2: string;
  /** Optional extra registers. When an allowlist entry pins one, the observed quote must match it too. */
  rtMr3?: string;
  mrOwner?: string;
  label?: string;
};

/** What one fresh TDX quote showed. */
export type TeeQuoteAttestation = {
  /**
   * `verified`: Intel's DCAP signature chain checked and the quote echoes our fresh challenge.
   * `challenge_bound`: the quote echoes our fresh challenge, but its signature chain wasn't checked.
   */
  hardware: "verified" | "challenge_bound";
  measurements: TeeMeasurement;
};

export type TeeIntegrityProvider = {
  /** Fresh-challenge quote check (genuine TDX hardware). Throws on failure. */
  verifyRpcIntegrity(teeUrl: string): Promise<void>;
  verifyIntegrity?(teeUrl: string): Promise<void>;
  /** Parse MRTD/RTMR0-2 from a fresh quote. Optional: only needed once an allowlist exists. */
  readMeasurements?(teeUrl: string): Promise<TeeMeasurement>;
  /**
   * Preferred: one fresh quote gives both the hardware verdict and the measurements,
   * so the build we compare is the one whose signature was checked. Throws on failure.
   */
  attestQuote?(teeUrl: string): Promise<TeeQuoteAttestation>;
};

export type AttestationMode = "report" | "enforce";

export type AttestationResult = {
  mode: AttestationMode;
  hardware: "verified" | "challenge_bound" | "failed";
  measurements: "matched" | "mismatch" | "pending" | "unavailable";
  /** Whether an authorizer may keep approving purchases. */
  ok: boolean;
  label: string;
  checkedAt: string;
  /** Which pinned entry matched (`current` / `previous` label), when one did. */
  matchedLabel?: string;
};

export type VerifyTeeOptions = {
  mode: AttestationMode;
  teeUrl?: string;
  /**
   * Allowed workload measurements (current + previous). Omitted: the pinned
   * MagicBlock values for the Devnet TEE, nothing for any other URL. An empty
   * list means "pending" (and fails closed in enforce mode).
   */
  allowlist?: readonly TeeMeasurement[];
  provider?: TeeIntegrityProvider;
  now?: () => number;
};

const MEASUREMENT_HEX = /^[0-9a-f]{96}$/;

/**
 * MagicBlock Devnet TEE validator measurements (gate G-MB).
 *
 * Observed by ChainPay in a fresh quote from devnet-tee.magicblock.app on
 * 2026-10-03 (and again 2026-10-04), then confirmed by MagicBlock directly to
 * Dre on 2026-10-04. That confirmation is not a signed or published source, so
 * the provenance label says so.
 *
 * Rotation: when MagicBlock upgrades the validator, move `current` to
 * `previous`, pin the new values as `current`, and drop `previous` once the
 * old build is gone. Deployments can also pass an extra entry through
 * `teeMeasurementAllowlist(extra)` (Axum: `CARDS_TEE_MEASUREMENTS`; frontend:
 * `VITE_CHAINPAY_TEE_MEASUREMENTS_PREVIOUS`) without a release.
 * Mirrored for Axum in shared/cards/tee-measurements.json (a test keeps them equal).
 */
export const MAGICBLOCK_DEVNET_TEE_MEASUREMENTS: {
  readonly teeUrl: string;
  readonly validator: Address;
  readonly provenance: string;
  readonly current: Required<Omit<TeeMeasurement, "label">> & { label: string };
  readonly previous: (TeeMeasurement & { label: string }) | null;
} = {
  teeUrl: DEVNET_TEE_URL,
  validator: "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo",
  provenance: "confirmed by MagicBlock to ChainPay, 2026-10-04 (direct, unsigned)",
  current: {
    label: "current",
    mrTd: "c1ee9c16e3afc506cfe042c5b846a368528f3b37618eafb27469bc114cf914e9222c91618470e7f2b28ac360968270a5",
    rtMr0: "c1f1f2bff33b16d1469134987fcdf0ea3bd9707350cc70e73f086c635a5fc4e96e0d214a7f775608e64d251382f20564",
    rtMr1: "b4fe8751e5d96b726a0dabb86ba821783626d80638caf6ca0045f31f5e4c4e90e20aee96fca711421db5bdc60e5c91ed",
    rtMr2: "51c09b72276c8bcd0e274865a7e0a408ee956a6ccfae8b4edd43467d7585ff352bb89e28f5cb62105114cad7225e11ef",
    rtMr3: "0".repeat(96),
    mrOwner: "44eeaee2768dd9b3a52b41747367e5751b18f7653f087febd7de11bffabbd1d75d4ff353a68154541215863ee7fc2903",
  },
  previous: null,
};

/** The pinned Devnet allowlist: `current`, then `previous` if a rotation is in progress, then any `extra` entries. */
export function teeMeasurementAllowlist(extra: readonly TeeMeasurement[] = []): TeeMeasurement[] {
  const pinned = MAGICBLOCK_DEVNET_TEE_MEASUREMENTS;
  return [pinned.current, ...(pinned.previous ? [pinned.previous] : []), ...extra];
}

function isDevnetTee(teeUrl: string): boolean {
  return teeUrl.replace(/\/+$/, "") === DEVNET_TEE_URL;
}

/**
 * Parse an allowlist (JSON list). Accepts the SDK keys (`mrTd`, `rtMr0`…) and
 * Axum's `CARDS_TEE_MEASUREMENTS` keys (`mrtd`, `rtmr0`…). Rejects anything
 * that isn't 48-byte hex.
 */
export function parseMeasurementAllowlist(json: string | undefined): TeeMeasurement[] {
  if (!json || !json.trim()) return [];
  const parsed = JSON.parse(json) as unknown;
  if (!Array.isArray(parsed)) throw new Error("CARDS_TEE_MEASUREMENTS must be a JSON list");
  return parsed.map((entry, i) => {
    const m = (entry ?? {}) as Record<string, unknown>;
    const field = (name: string, alias: string, required: boolean): string | undefined => {
      const raw = m[name] ?? m[alias];
      if (raw === undefined && !required) return undefined;
      const value = typeof raw === "string" ? raw.toLowerCase() : "";
      if (!MEASUREMENT_HEX.test(value)) throw new Error(`CARDS_TEE_MEASUREMENTS[${i}].${name} must be 48 bytes of hex`);
      return value;
    };
    const rtMr3 = field("rtMr3", "rtmr3", false);
    const mrOwner = field("mrOwner", "mrowner", false);
    return {
      mrTd: field("mrTd", "mrtd", true)!,
      rtMr0: field("rtMr0", "rtmr0", true)!,
      rtMr1: field("rtMr1", "rtmr1", true)!,
      rtMr2: field("rtMr2", "rtmr2", true)!,
      ...(rtMr3 ? { rtMr3 } : {}),
      ...(mrOwner ? { mrOwner } : {}),
      ...(m.label ? { label: String(m.label) } : {}),
    };
  });
}

function measurementMatches(actual: TeeMeasurement, allowed: TeeMeasurement): boolean {
  const required = (["mrTd", "rtMr0", "rtMr1", "rtMr2"] as const).every((field) => actual[field].toLowerCase() === allowed[field].toLowerCase());
  const pinned = (["rtMr3", "mrOwner"] as const).every((field) => allowed[field] === undefined || actual[field]?.toLowerCase() === allowed[field]!.toLowerCase());
  return required && pinned;
}

// ------------------------------------------------------------ TDX quotes

const TDX_QUOTE_HEADER = 48;
const TD10_REPORT_LENGTH = 584;
const TDX_TEE_TYPE = 0x81;

function hexOf(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Read the TD 1.0 report of a TDX quote (v4 or v5 with a TD10 body): MRTD,
 * MROWNER, RTMR0-3 and the 64-byte report data. Parsing only; it proves
 * nothing about who signed the quote.
 */
export function parseTdxQuote(raw: Uint8Array): { measurements: Required<Omit<TeeMeasurement, "label">>; reportData: Uint8Array } {
  if (raw.length < TDX_QUOTE_HEADER + TD10_REPORT_LENGTH) throw new Error("TDX quote is truncated");
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const version = view.getUint16(0, true);
  const teeType = view.getUint32(4, true);
  if (teeType !== TDX_TEE_TYPE) throw new Error("Not a TDX quote");
  // v5 inserts a 6-byte body descriptor (type u16 + size u32) before the report.
  let offset = TDX_QUOTE_HEADER;
  if (version === 5) {
    if (view.getUint16(TDX_QUOTE_HEADER, true) !== 2) throw new Error("Unsupported TDX quote body");
    offset += 6;
  } else if (version !== 4) {
    throw new Error(`Unsupported TDX quote version ${version}`);
  }
  const body = raw.subarray(offset, offset + TD10_REPORT_LENGTH);
  // TEE_TCB_SVN 16, MRSEAM 48, MRSIGNERSEAM 48, SEAMATTRIBUTES 8, TDATTRIBUTES 8, XFAM 8,
  // MRTD 48, MRCONFIGID 48, MROWNER 48, MROWNERCONFIG 48, RTMR0..3 48 each, REPORTDATA 64.
  const mrtd = 16 + 48 + 48 + 8 + 8 + 8;
  const mrowner = mrtd + 96;
  const rtmr0 = mrtd + 48 * 4;
  const reportData = rtmr0 + 48 * 4;
  const at = (start: number) => hexOf(body.subarray(start, start + 48));
  return {
    measurements: { mrTd: at(mrtd), mrOwner: at(mrowner), rtMr0: at(rtmr0), rtMr1: at(rtmr0 + 48), rtMr2: at(rtmr0 + 96), rtMr3: at(rtmr0 + 144) },
    reportData: body.slice(reportData, reportData + 64),
  };
}

function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64Decode(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

export type TdxQuoteProviderOptions = {
  fetch?: typeof fetch;
  /**
   * Verifies Intel's DCAP signature chain over the raw quote (e.g.
   * `@phala/dcap-qvl` getCollateral + verify). Throws when the quote isn't
   * genuine. Without it the provider reports `challenge_bound` only.
   */
  verifyQuote?: (raw: Uint8Array) => Promise<void>;
  /** Test hook for the 64-byte challenge. */
  randomBytes?: (length: number) => Uint8Array;
};

/**
 * Attestation from one fresh quote: GET `{tee}/quote?challenge=<base64 64 bytes>`
 * (the endpoint MagicBlock's verifyTeeRpcIntegrity uses), require the report
 * data to equal our challenge, optionally verify the DCAP chain, and return
 * the measurements of that same quote.
 */
export function createTdxQuoteProvider(options: TdxQuoteProviderOptions = {}): TeeIntegrityProvider {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const random = options.randomBytes ?? ((length: number) => globalThis.crypto.getRandomValues(new Uint8Array(length)));
  const attestQuote = async (teeUrl: string): Promise<TeeQuoteAttestation> => {
    const challenge = random(64);
    const response = await doFetch(`${teeUrl.replace(/\/+$/, "")}/quote?challenge=${encodeURIComponent(base64Encode(challenge))}`);
    const body = await response.json().catch(() => null) as { quote?: unknown } | null;
    if (!response.ok || typeof body?.quote !== "string") throw new Error("The TEE didn't return a quote");
    const raw = base64Decode(body.quote);
    const { measurements, reportData } = parseTdxQuote(raw);
    if (reportData.length !== challenge.length || reportData.some((byte, i) => byte !== challenge[i])) throw new Error("Quote doesn't answer our challenge");
    if (options.verifyQuote) {
      await options.verifyQuote(raw);
      return { hardware: "verified", measurements };
    }
    return { hardware: "challenge_bound", measurements };
  };
  return {
    attestQuote,
    async verifyRpcIntegrity(teeUrl) {
      if ((await attestQuote(teeUrl)).hardware !== "verified") throw new Error("Quote signature wasn't verified");
    },
    readMeasurements: async (teeUrl) => (await attestQuote(teeUrl)).measurements,
  };
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

/** Plain-language result. Claims only what the check established. */
function attestationLabel(hardware: "verified" | "challenge_bound", measurements: "matched" | "mismatch" | "pending" | "unavailable", mode: AttestationMode, devnet: boolean): string {
  const build = devnet ? "MagicBlock's confirmed Devnet build" : "an allowlisted build";
  const paused = mode === "enforce" ? ", so approvals are paused" : " (report only)";
  if (measurements === "pending") return mode === "enforce" ? "Enforce mode has no measurement allowlist, so approvals are paused" : "Hardware verified, measurements pending";
  if (measurements === "unavailable") return `Hardware verified, but the workload couldn't be checked${paused}`;
  if (measurements === "mismatch") return `The private rollup is running a build that isn't ${build}${paused}`;
  if (hardware === "verified") return devnet ? "Genuine TDX hardware and expected MagicBlock build verified (Devnet)" : "Genuine TDX hardware and allowlisted workload verified";
  return devnet
    ? "The private rollup answered a fresh challenge with MagicBlock's expected Devnet build. Intel's hardware signature wasn't checked here."
    : "The TEE answered a fresh challenge with an allowlisted build. Intel's hardware signature wasn't checked here.";
}

export async function verifyTee(options: VerifyTeeOptions): Promise<AttestationResult> {
  const teeUrl = (options.teeUrl ?? DEVNET_TEE_URL).replace(/\/+$/, "");
  const devnet = isDevnetTee(teeUrl);
  const checkedAt = new Date((options.now ?? Date.now)()).toISOString();
  const allowlist = options.allowlist ?? (devnet ? teeMeasurementAllowlist() : []);
  const base = { mode: options.mode, checkedAt };
  const hardwareFailed: AttestationResult = { ...base, hardware: "failed", measurements: "unavailable", ok: false, label: "Couldn't confirm the private rollup runs on genuine secure hardware." };
  let provider: TeeIntegrityProvider;
  let hardware: "verified" | "challenge_bound";
  let actual: TeeMeasurement | undefined;
  try {
    provider = options.provider ?? await loadMagicBlockIntegrityProvider();
    if (provider.attestQuote) {
      const attested = await provider.attestQuote(teeUrl);
      hardware = attested.hardware;
      actual = attested.measurements;
    } else {
      await provider.verifyRpcIntegrity(teeUrl);
      if (provider.verifyIntegrity) await provider.verifyIntegrity(teeUrl);
      hardware = "verified";
    }
  } catch {
    return hardwareFailed;
  }
  if (allowlist.length === 0) {
    // Enforce without an allowlist is a misconfiguration: fail closed.
    return { ...base, hardware, measurements: "pending", ok: options.mode === "report", label: attestationLabel(hardware, "pending", options.mode, devnet) };
  }
  if (!actual) {
    try {
      if (!provider.readMeasurements) throw new Error("no measurement reader");
      actual = await provider.readMeasurements(teeUrl);
    } catch {
      return { ...base, hardware, measurements: "unavailable", ok: options.mode === "report", label: attestationLabel(hardware, "unavailable", options.mode, devnet) };
    }
  }
  const matched = allowlist.find((allowed) => measurementMatches(actual!, allowed));
  if (matched) {
    // Enforce needs Intel's signature chain: an unsigned quote is just bytes the endpoint chose.
    return { ...base, hardware, measurements: "matched", ok: options.mode === "report" || hardware === "verified", label: attestationLabel(hardware, "matched", options.mode, devnet), ...(matched.label ? { matchedLabel: matched.label } : {}) };
  }
  return { ...base, hardware, measurements: "mismatch", ok: options.mode === "report", label: attestationLabel(hardware, "mismatch", options.mode, devnet) };
}
