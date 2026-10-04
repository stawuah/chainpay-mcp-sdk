import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { convexTest } from 'convex-test';
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import schema from './schema';
import { MAX_ACCOUNT_BYTES, RATE_LIMITS, checkRelayRequest, checkSupportTransaction } from './supportRpc';

const modules = import.meta.glob(['./**/*.ts', '!./**/*.test.ts']);
const PROGRAM = 'D1DvnVq37696mcFB5JeVWZy22wjxZ5xPJmZazbfPK7BH';
const config = { programId: PROGRAM };
const MEMO = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const JUPITER = new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
const ALLOCATE_SOL = [14, 16, 184, 134, 218, 1, 37, 35];
const SHARED_ROUTE = [193, 32, 155, 51, 65, 214, 156, 129];
const donor = Keypair.generate();
const vault = PublicKey.findProgramAddressSync([Buffer.from('vault')], new PublicKey(PROGRAM))[0];
const blockhash = '11111111111111111111111111111111';

const memo = () => new TransactionInstruction({ programId: MEMO, keys: [{ pubkey: donor.publicKey, isSigner: true, isWritable: false }], data: Buffer.from('chainpay-support:v1') });
const allocate = () => new TransactionInstruction({ programId: new PublicKey(PROGRAM), keys: [{ pubkey: vault, isSigner: false, isWritable: true }], data: Buffer.from(ALLOCATE_SOL) });
const legacy = (ixs: TransactionInstruction[]) => {
  const tx = new Transaction({ feePayer: donor.publicKey, blockhash, lastValidBlockHeight: 1 }).add(...ixs);
  tx.sign(donor);
  return tx.serialize().toString('base64');
};
const v0 = (ixs: TransactionInstruction[]) => {
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: donor.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message());
  tx.sign([donor]);
  return Buffer.from(tx.serialize()).toString('base64');
};
const tip = () => [SystemProgram.transfer({ fromPubkey: donor.publicKey, toPubkey: vault, lamports: 1_000 }), memo(), allocate()];
const send = (base64: string) => JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: [base64, { encoding: 'base64' }] });
const call = (method: string, params: unknown[] = []) => JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
const ADDRESS = donor.publicKey.toBase58();

describe('support RPC relay: request checks', () => {
  it('forwards only the calls the tip card makes, with valid params', () => {
    expect(checkRelayRequest(call('getBalance', [ADDRESS, { commitment: 'confirmed' }]), config).ok).toBe(true);
    expect(checkRelayRequest(call('getTokenAccountBalance', [ADDRESS]), config).ok).toBe(true);
    expect(checkRelayRequest(call('getLatestBlockhash', [{ commitment: 'confirmed' }]), config).ok).toBe(true);
    expect(checkRelayRequest(call('getBlockHeight'), config).ok).toBe(true);
    expect(checkRelayRequest(call('getSignatureStatuses', [['5'.repeat(88)], { searchTransactionHistory: true }]), config).ok).toBe(true);
    for (const method of ['getProgramAccounts', 'requestAirdrop', 'getSignaturesForAddress', 'getTransaction', '__proto__']) {
      expect(checkRelayRequest(call(method), config)).toMatchObject({ ok: false, status: 403 });
    }
    expect(checkRelayRequest(call('getBalance', ['not an address']), config)).toMatchObject({ ok: false, status: 400 });
    expect(checkRelayRequest(call('getBalance', [ADDRESS, {}, 'extra']), config)).toMatchObject({ ok: false, status: 400 });
    expect(checkRelayRequest(call('getSignatureStatuses', [Array(11).fill('5'.repeat(88))]), config)).toMatchObject({ ok: false, status: 400 });
    expect(checkRelayRequest(call('getSignatureStatuses', ['x'.repeat(10)]), config)).toMatchObject({ ok: false, status: 400 });
  });

  it('rejects batches, junk and oversized bodies', () => {
    expect(checkRelayRequest(JSON.stringify([{ method: 'getBalance' }]), config)).toMatchObject({ ok: false, status: 400 });
    expect(checkRelayRequest('{nope', config)).toMatchObject({ ok: false, status: 400 });
    expect(checkRelayRequest(JSON.stringify({ method: 'getBalance', params: 'x' }), config)).toMatchObject({ ok: false, status: 400 });
    expect(checkRelayRequest(send('A'.repeat(9000)), config)).toMatchObject({ ok: false, status: 413 });
  });

  it('caps every account read, so a multi-megabyte account costs no more than a lookup table (review F2)', () => {
    const check = checkRelayRequest(call('getAccountInfo', [JUPITER.toBase58(), { encoding: 'base64' }]), config);
    expect(check.ok && check.body.params[1]).toMatchObject({ encoding: 'base64', dataSlice: { offset: 0, length: MAX_ACCOUNT_BYTES } });
    const small = checkRelayRequest(call('getAccountInfo', [ADDRESS, { dataSlice: { offset: 0, length: 0 } }]), config);
    expect(small.ok && small.body.params[1]).toMatchObject({ dataSlice: { offset: 0, length: 0 } });
    const huge = checkRelayRequest(call('getAccountInfo', [ADDRESS, { dataSlice: { offset: 0, length: 10_000_000 } }]), config);
    expect(huge.ok && huge.body.params[1]).toMatchObject({ dataSlice: { length: MAX_ACCOUNT_BYTES } });
    expect(checkRelayRequest(call('getAccountInfo', [ADDRESS, { encoding: 'jsonParsed' }]), config)).toMatchObject({ ok: false, status: 400 });
  });

  it('relays support transactions, legacy and v0 (with a Jupiter swap)', () => {
    expect(checkRelayRequest(send(legacy(tip())), config).ok).toBe(true);
    const swap = new TransactionInstruction({ programId: JUPITER, keys: [], data: Buffer.from([...SHARED_ROUTE, 1, 0, 0, 0, 0]) });
    expect(checkRelayRequest(send(v0([swap, memo(), allocate()])), config).ok).toBe(true);
  });

  it('refuses any other transaction on the paid key (review F2 repro)', () => {
    const thief = Keypair.generate().publicKey;
    const cases: [string, string][] = [
      ['an unrelated transfer', legacy([SystemProgram.transfer({ fromPubkey: donor.publicKey, toPubkey: thief, lamports: 1 })])],
      ['an unknown program next to a tip', legacy([...tip(), new TransactionInstruction({ programId: thief, keys: [], data: Buffer.alloc(0) })])],
      ['a non-transfer System instruction', legacy([SystemProgram.assign({ accountPubkey: donor.publicKey, programId: thief }), memo(), allocate()])],
      ['an unknown support instruction', legacy([new TransactionInstruction({ programId: new PublicKey(PROGRAM), keys: [], data: Buffer.alloc(8, 7) })])],
      ['a Jupiter instruction other than a route', v0([new TransactionInstruction({ programId: JUPITER, keys: [], data: Buffer.alloc(8, 9) }), memo(), allocate()])],
      ['junk bytes', Buffer.from('AQ' + 'A'.repeat(1500), 'base64').toString('base64')],
    ];
    for (const [label, tx] of cases) {
      expect(checkRelayRequest(send(tx), config), label).toMatchObject({ ok: false, status: 403 });
    }
    expect(checkRelayRequest(JSON.stringify({ method: 'sendTransaction', params: [legacy(tip())] }), config)).toMatchObject({ ok: false, status: 400 });
    expect(checkSupportTransaction(Buffer.from(legacy(tip()), 'base64'), Keypair.generate().publicKey.toBase58())).toMatch(/program a tip doesn't use/);
  });
});

describe('support RPC relay: route', () => {
  const upstream = vi.fn();
  beforeEach(() => {
    vi.stubEnv('SUPPORT_LIVE', 'true');
    vi.stubEnv('SUPPORT_RELAY_RPC_URL', 'https://relay-rpc.invalid/?key=relay');
    vi.stubEnv('SUPPORT_RPC_URL', 'https://tracker-rpc.invalid/?key=tracker');
    vi.stubEnv('SUPPORT_PROGRAM_ID', PROGRAM);
    upstream.mockReset();
    upstream.mockImplementation(async () => new Response('{"jsonrpc":"2.0","id":1,"result":1}', { status: 200 }));
    vi.stubGlobal('fetch', upstream);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  const post = (t: ReturnType<typeof convexTest>, body: string, ip = '203.0.113.7') => t.fetch('/support/rpc', { method: 'POST', headers: { 'x-forwarded-for': ip }, body });

  it('is off until SUPPORT_LIVE, and never uses the tracker key', async () => {
    const t = convexTest(schema, modules);
    vi.stubEnv('SUPPORT_LIVE', '');
    expect((await post(t, call('getBlockHeight'))).status).toBe(503);
    vi.stubEnv('SUPPORT_LIVE', 'true');
    vi.stubEnv('SUPPORT_RELAY_RPC_URL', '');
    expect((await post(t, call('getBlockHeight'))).status).toBe(503);
    expect(upstream).not.toHaveBeenCalled();
    vi.stubEnv('SUPPORT_RELAY_RPC_URL', 'https://relay-rpc.invalid/?key=relay');
    expect((await post(t, call('getBlockHeight'))).status).toBe(200);
    expect(upstream.mock.calls[0][0]).toContain('key=relay');
    expect(upstream.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it('refuses an unrelated transaction before spending the key', async () => {
    const t = convexTest(schema, modules);
    const res = await post(t, send(legacy([SystemProgram.transfer({ fromPubkey: donor.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 })])));
    expect(res.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('rate-limits sends and calls per IP, separately for each IP', async () => {
    const t = convexTest(schema, modules);
    for (let i = 0; i < RATE_LIMITS.ipSendsPerMinute; i++) expect((await post(t, send(legacy(tip())))).status).toBe(200);
    expect((await post(t, send(legacy(tip())))).status).toBe(429);
    expect((await post(t, send(legacy(tip())), '198.51.100.9')).status).toBe(200);
    // The refused 7th send was not counted.
    for (let i = RATE_LIMITS.ipSendsPerMinute; i < RATE_LIMITS.ipPerMinute; i++) await post(t, call('getBlockHeight'));
    expect((await post(t, call('getBlockHeight'))).status).toBe(429);
    expect((await post(t, call('getBlockHeight'), '198.51.100.9')).status).toBe(200);
  });

  it('drops an oversized upstream answer', async () => {
    const t = convexTest(schema, modules);
    upstream.mockImplementation(async () => new Response('x'.repeat(100_000), { status: 200 }));
    expect((await post(t, call('getBlockHeight'))).status).toBe(502);
  });
});
