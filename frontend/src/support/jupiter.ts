// Decodes a Jupiter v6 swap instruction exactly as the on-chain program will read
// it, so swap.ts can check the amounts, slippage, fee and destination it carries.
//
// The route plan is a list of DEX steps whose byte sizes differ per DEX, so the
// layout comes from Jupiter's own Anchor IDL (jupiter-idl.json, refreshed by
// frontend/test/fixtures/jupiter/capture.mjs). Anything the IDL doesn't describe
// (a new DEX, another instruction, trailing bytes) is refused, never guessed.
import idl from "./jupiter-idl.json";

type IdlType = string | { defined?: { name: string }; vec?: IdlType; option?: IdlType; array?: [IdlType, number] };
type IdlField = { name?: string; type: IdlType } | IdlType;
type IdlTypeDef = { name: string; type: { kind: "struct" | "enum"; fields?: IdlField[]; variants?: { name: string; fields?: IdlField[] }[] } };

const TYPES = new Map((idl.types as IdlTypeDef[]).map((t) => [t.name, t]));
const FIXED: Record<string, number> = { bool: 1, u8: 1, i8: 1, u16: 2, i16: 2, u32: 4, i32: 4, u64: 8, i64: 8, u128: 16, i128: 16, pubkey: 32 };
// Far above any real route; stops a forged length from making us loop.
const MAX_ITEMS = 64;

export type JupiterSwapKind = "route" | "shared_accounts_route";
export type DecodedSwap = {
  kind: JupiterSwapKind;
  /** Index of each named account in the instruction's account list. */
  accounts: Record<string, number>;
  inAmount: bigint;
  quotedOutAmount: bigint;
  slippageBps: number;
  platformFeeBps: number;
};

class Reader {
  offset = 0;
  constructor(readonly data: Uint8Array) {}
  take(n: number) {
    if (this.offset + n > this.data.length) throw new Error("Swap data is cut short.");
    const start = this.offset;
    this.offset += n;
    return this.data.subarray(start, this.offset);
  }
  uint(bytes: number) {
    let value = 0n;
    const slice = this.take(bytes);
    for (let i = bytes - 1; i >= 0; i--) value = (value << 8n) | BigInt(slice[i]);
    return value;
  }
}

function skip(reader: Reader, type: IdlType): void {
  if (typeof type === "string") {
    if (type === "bool") {
      if (reader.take(1)[0] > 1) throw new Error("Swap data has a bad flag.");
      return;
    }
    if (type === "bytes" || type === "string") {
      reader.take(Number(reader.uint(4)));
      return;
    }
    const size = FIXED[type];
    if (!size) throw new Error(`Swap data uses an unknown type ${type}.`);
    reader.take(size);
    return;
  }
  if (type.vec !== undefined) {
    const count = Number(reader.uint(4));
    if (count > MAX_ITEMS) throw new Error("Swap data is too long.");
    for (let i = 0; i < count; i++) skip(reader, type.vec);
    return;
  }
  if (type.option !== undefined) {
    const tag = reader.take(1)[0];
    if (tag > 1) throw new Error("Swap data has a bad option.");
    if (tag === 1) skip(reader, type.option);
    return;
  }
  if (type.array !== undefined) {
    const [inner, count] = type.array;
    for (let i = 0; i < count; i++) skip(reader, inner);
    return;
  }
  const def = type.defined && TYPES.get(type.defined.name);
  if (!def) throw new Error("Swap data uses an unknown type.");
  if (def.type.kind === "struct") {
    for (const field of def.type.fields ?? []) skip(reader, fieldType(field));
    return;
  }
  const variant = def.type.variants?.[reader.take(1)[0]];
  // A DEX added after jupiter-idl.json was captured lands here.
  if (!variant) throw new Error("Swap goes through a DEX this page doesn't recognise yet.");
  for (const field of variant.fields ?? []) skip(reader, fieldType(field));
}

function fieldType(field: IdlField): IdlType {
  return typeof field === "object" && "type" in field && field.type !== undefined ? (field.type as IdlType) : (field as IdlType);
}

/** Throws unless `data` is exactly one route / shared_accounts_route call. */
export function decodeJupiterSwap(data: Uint8Array): DecodedSwap {
  const ix = idl.instructions.find((candidate) => candidate.discriminator.every((byte, i) => data[i] === byte));
  if (!ix || data.length < 8) throw new Error("Swap uses a Jupiter instruction this page doesn't allow.");
  const reader = new Reader(data);
  reader.take(8);
  const values: Record<string, bigint> = {};
  for (const arg of ix.args) {
    const type = arg.type as IdlType;
    if (typeof type === "string" && FIXED[type] && type !== "bool") values[arg.name] = reader.uint(FIXED[type]);
    else skip(reader, type);
  }
  // Anchor ignores trailing bytes, so a decoder that read from the end could be
  // fooled. Require the data to be exactly the arguments.
  if (reader.offset !== data.length) throw new Error("Swap data has extra bytes.");
  return {
    kind: ix.name as JupiterSwapKind,
    accounts: Object.fromEntries(ix.accounts.map((name, index) => [name, index])),
    inAmount: values.in_amount,
    quotedOutAmount: values.quoted_out_amount,
    slippageBps: Number(values.slippage_bps),
    platformFeeBps: Number(values.platform_fee_bps),
  };
}
