import { PublicKey } from "@solana/web3.js";
import type { Address } from "../types.js";
import { publicKey } from "../encoding.js";

const U64_MAX = 18_446_744_073_709_551_615n;
const I64_MIN = -9_223_372_036_854_775_808n;
const I64_MAX = 9_223_372_036_854_775_807n;

/** Little-endian Borsh writer for the fixed card_policy layouts. */
export class BorshWriter {
  private readonly parts: Uint8Array[] = [];

  u8(value: number, name = "u8"): this {
    if (!Number.isInteger(value) || value < 0 || value > 0xff) throw new Error(`${name} must fit in u8`);
    this.parts.push(Uint8Array.of(value));
    return this;
  }

  u16(value: number, name = "u16"): this {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) throw new Error(`${name} must fit in u16`);
    const bytes = new Uint8Array(2);
    new DataView(bytes.buffer).setUint16(0, value, true);
    this.parts.push(bytes);
    return this;
  }

  u32(value: number, name = "u32"): this {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) throw new Error(`${name} must fit in u32`);
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value, true);
    this.parts.push(bytes);
    return this;
  }

  u64(value: bigint, name = "u64"): this {
    if (typeof value !== "bigint" || value < 0n || value > U64_MAX) throw new Error(`${name} must fit in u64`);
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigUint64(0, value, true);
    this.parts.push(bytes);
    return this;
  }

  i64(value: bigint, name = "i64"): this {
    if (typeof value !== "bigint" || value < I64_MIN || value > I64_MAX) throw new Error(`${name} must fit in i64`);
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigInt64(0, value, true);
    this.parts.push(bytes);
    return this;
  }

  bool(value: boolean): this {
    this.parts.push(Uint8Array.of(value ? 1 : 0));
    return this;
  }

  fixed(value: Uint8Array, length: number, name: string): this {
    if (!(value instanceof Uint8Array) || value.length !== length) throw new Error(`${name} must be exactly ${length} bytes`);
    this.parts.push(new Uint8Array(value));
    return this;
  }

  pubkey(value: Address, _name = "pubkey"): this {
    this.parts.push(publicKey(value).toBytes());
    return this;
  }

  bytes(value: Uint8Array): this {
    this.parts.push(new Uint8Array(value));
    return this;
  }

  toBytes(): Uint8Array {
    const total = this.parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of this.parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }
}

/** Little-endian Borsh reader. Every read is bounds-checked. */
export class BorshReader {
  offset: number;
  private readonly view: DataView;

  constructor(private readonly data: Uint8Array, offset = 0) {
    this.offset = offset;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  private need(length: number, name: string): void {
    if (this.offset + length > this.data.length) throw new Error(`Data ended while reading ${name}`);
  }

  u8(name = "u8"): number {
    this.need(1, name);
    return this.data[this.offset++];
  }

  u16(name = "u16"): number {
    this.need(2, name);
    const value = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return value;
  }

  u32(name = "u32"): number {
    this.need(4, name);
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  u64(name = "u64"): bigint {
    this.need(8, name);
    const value = this.view.getBigUint64(this.offset, true);
    this.offset += 8;
    return value;
  }

  i64(name = "i64"): bigint {
    this.need(8, name);
    const value = this.view.getBigInt64(this.offset, true);
    this.offset += 8;
    return value;
  }

  bool(name = "bool"): boolean {
    const value = this.u8(name);
    if (value > 1) throw new Error(`${name} is not a valid bool`);
    return value === 1;
  }

  fixed(length: number, name: string): Uint8Array {
    this.need(length, name);
    const value = new Uint8Array(this.data.slice(this.offset, this.offset + length));
    this.offset += length;
    return value;
  }

  pubkey(name = "pubkey"): Address {
    return new PublicKey(this.fixed(32, name)).toBase58();
  }

  remaining(): number {
    return this.data.length - this.offset;
  }
}

export const ZERO_ADDRESS: Address = PublicKey.default.toBase58();
