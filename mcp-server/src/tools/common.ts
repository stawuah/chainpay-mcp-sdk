import { publicKey, type Address } from "@chainpay/sdk";

export function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

export function solanaAddress(value: unknown, name: string): Address {
  const candidate = requiredString(value, name);
  return publicKey(candidate).toBase58();
}

export function unsignedInteger(value: unknown, name: string): bigint {
  const candidate = typeof value === "number" ? String(value) : requiredString(value, name);
  if (!/^\d+$/.test(candidate)) throw new Error(`${name} must be an unsigned integer string`);
  const parsed = BigInt(candidate);
  if (parsed < 0n || parsed > 18_446_744_073_709_551_615n) {
    throw new Error(`${name} must fit in an unsigned 64-bit integer`);
  }
  return parsed;
}

export function hex32(value: unknown, name: string): Uint8Array {
  const candidate = requiredString(value, name).replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(candidate)) {
    throw new Error(`${name} must be exactly 32 bytes encoded as hexadecimal`);
  }
  const result = new Uint8Array(32);
  for (let index = 0; index < 32; index += 1) {
    result[index] = Number.parseInt(candidate.slice(index * 2, index * 2 + 2), 16);
  }
  return result;
}

export function tokenProgram(value: unknown, name = "tokenProgram") {
  const candidate = requiredString(value, name);
  if (candidate !== "spl-token" && candidate !== "token-2022") {
    throw new Error(`${name} must be spl-token or token-2022`);
  }
  return candidate;
}

export function jsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) {
    return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, jsonSafe(item)]),
    );
  }
  return value;
}

function base64FromUint8Array(bytes: Uint8Array): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let result = "";
  let i = 0;

  for (; i + 2 < bytes.length; i += 3) {
    const triple = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    result += chars[(triple >> 18) & 0x3f];
    result += chars[(triple >> 12) & 0x3f];
    result += chars[(triple >> 6) & 0x3f];
    result += chars[triple & 0x3f];
  }

  const remaining = bytes.length - i;
  if (remaining === 1) {
    const triple = bytes[i] << 16;
    result += chars[(triple >> 18) & 0x3f];
    result += chars[(triple >> 12) & 0x3f];
    result += "==";
  } else if (remaining === 2) {
    const triple = (bytes[i] << 16) | (bytes[i + 1] << 8);
    result += chars[(triple >> 18) & 0x3f];
    result += chars[(triple >> 12) & 0x3f];
    result += chars[(triple >> 6) & 0x3f];
    result += "=";
  }

  return result;
}

export function serializeTransaction(transaction: {
  instructions: Array<{
    name: string;
    programId: string;
    keys: Array<{ address: string; isSigner: boolean; isWritable: boolean }>;
    data: Uint8Array;
  }>;
  requiredSigners: string[];
  feePayer?: string;
}) {
  return {
    feePayer: transaction.feePayer,
    requiredSigners: transaction.requiredSigners,
    instructions: transaction.instructions.map((item) => ({
      name: item.name,
      programId: item.programId,
      keys: item.keys,
      dataBase64: base64FromUint8Array(item.data),
    })),
  };
}

export function toolResult(data: unknown, isError = false) {
  const safe = jsonSafe(data);
  return {
    isError: isError || undefined,
    structuredContent: safe,
    content: [{ type: "text", text: JSON.stringify(safe) }],
  };
}

