// A narrow JSON-RPC relay for the /support page. Browsers can't use Solana's
// public mainnet RPC (it answers 403), and an RPC URL with an API key must never
// ship to the browser, so the page talks to this route instead. Nothing here can
// sign or move funds: the wallet signs, and the page checks the transaction's
// contents before signing.
//
// Because the route is public and shares this Convex deployment, it is bounded:
//   - off unless SUPPORT_LIVE=true and SUPPORT_CLUSTER=devnet, and it uses its own key (SUPPORT_RELAY_RPC_URL),
//     so abuse can't spend the tracker's quota;
//   - only the calls the tip card makes, each with checked params;
//   - account reads are capped at MAX_ACCOUNT_BYTES, responses at MAX_RESPONSE_BYTES;
//   - sendTransaction only relays a transaction that calls the support program and
//     nothing outside the programs a tip uses;
//   - per-IP and global rate limits (checked after the cheap checks above), and an
//     upstream timeout.

export const ALLOWED_METHODS = new Set([
  "getBalance",
  "getTokenAccountBalance",
  "getLatestBlockhash",
  "getAccountInfo", // vault ledger, swap lookup tables, does-this-token-account-exist
  "sendTransaction",
  "getSignatureStatuses",
  "getBlockHeight",
  "getGenesisHash", // the page checks it is really reading Devnet before it lets anyone sign
]);

export const MAX_BODY_BYTES = 8_192; // a full signed transaction is ~1.7 KB base64
// The largest account the page reads is an address lookup table: 56 + 256 * 32 bytes.
export const MAX_ACCOUNT_BYTES = 56 + 256 * 32;
export const MAX_RESPONSE_BYTES = 32_768;
export const UPSTREAM_TIMEOUT_MS = 10_000;

// One tip is roughly 70 calls over a minute (most are confirmation polls).
export const RATE_LIMITS = {
  ipPerMinute: 150,
  ipSendsPerMinute: 6,
  globalPerMinute: 3_000,
} as const;

const SYSTEM = "11111111111111111111111111111111";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ATA = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
const MEMO = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const JUPITER = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
// Some wallets (Phantom) append Lighthouse assertion instructions before signing.
const LIGHTHOUSE = "L2TExMFKdjpN9kozasaurPtAaCGqXGTDUDiKN3EuHHB";
// sha256("global:<name>")[..8]
const SUPPORT_IXS = ["0e10b886da012523", "f72fe3dfcd8f9b38", "83659a3225880d43", "18013a5f085283dd"]; // allocate_sol, allocate_usdc, pay_sol, pay_usdc
const JUPITER_IXS = ["e517cb977ae3ad2a", "c1209b3341d69c81"]; // route, shared_accounts_route

export type RelayConfig = { programId: string };
export type RelayBody = { jsonrpc: "2.0"; id: unknown; method: string; params: unknown[] };
export type RelayCheck = { ok: true; body: RelayBody } | { ok: false; status: number; message: string };

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes: Uint8Array) {
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "";
  for (const byte of bytes) {
    if (byte !== 0) break;
    out += "1";
  }
  // An all-zero key (the System program) is only its leading "1"s.
  if (digits.length === 1 && digits[0] === 0) return out;
  return out + digits.reverse().map((d) => B58[d]).join("");
}

const isAddress = (value: unknown) => typeof value === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
const isSignature = (value: unknown) => typeof value === "string" && /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(value);
const isConfig = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const optionalConfig = (params: unknown[], at: number) => params.length <= at || (params.length === at + 1 && isConfig(params[at]));
const fail = (status: number, message: string): RelayCheck => ({ ok: false, status, message });
const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/**
 * Reads a legacy or v0 wire transaction and returns why it isn't a support
 * transaction, or null. Program ids are always static keys, so no lookup table
 * is needed to know which programs run.
 */
export function checkSupportTransaction(bytes: Uint8Array, programId: string): string | null {
  let offset = 0;
  const byte = () => {
    if (offset >= bytes.length) throw new Error("short");
    return bytes[offset++];
  };
  const take = (n: number) => {
    if (n < 0 || offset + n > bytes.length) throw new Error("short");
    offset += n;
    return bytes.subarray(offset - n, offset);
  };
  const compact = () => {
    let value = 0;
    for (let shift = 0; shift < 21; shift += 7) {
      const b = byte();
      value |= (b & 0x7f) << shift;
      if (!(b & 0x80)) return value;
    }
    throw new Error("bad length");
  };
  try {
    take(compact() * 64);
    if (bytes[offset] & 0x80 && byte() !== 0x80) return "unsupported transaction version";
    take(3);
    const keyCount = compact();
    const keys = Array.from({ length: keyCount }, () => base58(take(32)));
    take(32); // blockhash
    const allowed = new Set([SYSTEM, TOKEN, ATA, COMPUTE_BUDGET, MEMO, JUPITER, LIGHTHOUSE, programId]);
    let callsSupport = false;
    const count = compact();
    for (let i = 0; i < count; i++) {
      const program = keys[byte()];
      take(compact());
      const data = take(compact());
      if (!program || !allowed.has(program)) return "calls a program a tip doesn't use";
      const tag = hex(data.subarray(0, 8));
      if (program === programId) {
        if (!SUPPORT_IXS.includes(tag)) return "unknown support instruction";
        callsSupport = true;
      }
      if (program === JUPITER && !JUPITER_IXS.includes(tag)) return "unknown swap instruction";
      if (program === SYSTEM && !(data.length === 12 && data[0] === 2 && data[1] === 0 && data[2] === 0 && data[3] === 0)) return "unexpected system instruction";
      if (program === TOKEN && !(data[0] === 12 || data[0] === 9)) return "unexpected token instruction";
    }
    if (!callsSupport) return "doesn't call the support program";
    return null;
  } catch {
    return "not a transaction";
  }
}

function decodeBase64(text: string) {
  try {
    return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** Accepts one JSON-RPC request the tip card makes; rejects batches, junk and anything broader. */
export function checkRelayRequest(text: string, config: RelayConfig): RelayCheck {
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return fail(413, "Request too large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail(400, "Invalid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fail(400, "One request at a time");
  const { method, params: rawParams, id } = parsed as { method?: unknown; params?: unknown; id?: unknown };
  if (typeof method !== "string" || !ALLOWED_METHODS.has(method)) return fail(403, "Method not allowed");
  if (rawParams !== undefined && !Array.isArray(rawParams)) return fail(400, "params must be an array");
  if (id !== undefined && id !== null && typeof id !== "number" && typeof id !== "string") return fail(400, "Invalid id");
  let params = (rawParams as unknown[] | undefined) ?? [];
  const bad = fail(400, "Invalid params");

  switch (method) {
    case "getBalance":
    case "getTokenAccountBalance":
      if (!isAddress(params[0]) || !optionalConfig(params, 1)) return bad;
      break;
    case "getGenesisHash":
      if (params.length !== 0) return bad;
      break;
    case "getLatestBlockhash":
    case "getBlockHeight":
      if (!optionalConfig(params, 0)) return bad;
      break;
    case "getSignatureStatuses": {
      const sigs = params[0];
      if (!Array.isArray(sigs) || sigs.length === 0 || !sigs.every(isSignature) || !optionalConfig(params, 1)) return bad;
      if (sigs.length > 10) return fail(400, "Too many signatures");
      break;
    }
    case "getAccountInfo": {
      if (!isAddress(params[0]) || !optionalConfig(params, 1)) return bad;
      const given = (params[1] ?? {}) as Record<string, unknown>;
      if (given.encoding !== undefined && given.encoding !== "base64") return fail(400, "Only base64 account data");
      const slice = given.dataSlice as { offset?: unknown; length?: unknown } | undefined;
      if (slice !== undefined && (!isConfig(slice) || !Number.isSafeInteger(slice.offset) || !Number.isSafeInteger(slice.length) || (slice.offset as number) < 0 || (slice.length as number) < 0)) return bad;
      // Always slice, so an unrelated multi-megabyte account costs no more than a lookup table.
      const dataSlice = { offset: (slice?.offset as number) ?? 0, length: Math.min((slice?.length as number) ?? MAX_ACCOUNT_BYTES, MAX_ACCOUNT_BYTES) };
      params = [params[0], { ...given, encoding: "base64", dataSlice }];
      break;
    }
    case "sendTransaction": {
      if (typeof params[0] !== "string" || !optionalConfig(params, 1)) return bad;
      const given = (params[1] ?? {}) as Record<string, unknown>;
      if (given.encoding !== "base64") return fail(400, "Only base64 transactions");
      const bytes = decodeBase64(params[0]);
      if (!bytes) return bad;
      const problem = checkSupportTransaction(bytes, config.programId);
      if (problem) return fail(403, `Not a support transaction: ${problem}`);
      break;
    }
  }
  return { ok: true, body: { jsonrpc: "2.0", id: id ?? 1, method, params } };
}

/** Reads at most `limit` bytes of a response body; null when it's longer. */
export async function readLimited(response: { body: ReadableStream<Uint8Array> | null }, limit = MAX_RESPONSE_BYTES): Promise<string | null> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    joined.set(chunk, at);
    at += chunk.length;
  }
  return new TextDecoder().decode(joined);
}

/** The caller's IP, hashed so raw addresses aren't stored. Unknown callers share one bucket. */
export async function clientKey(headers: Headers) {
  const ip = headers.get("x-forwarded-for")?.split(",")[0]?.trim() || headers.get("x-real-ip")?.trim() || "unknown";
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`support-rpc:${ip}`)));
  return hex(digest.subarray(0, 16));
}
