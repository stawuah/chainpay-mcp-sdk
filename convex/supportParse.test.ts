import { describe, expect, it } from 'vitest';
import { advanceCursor, parseSupportMemo, parseSupportTx, planPage, summarize, type RpcTransaction, type StoredEvent, type SupportCursor } from './supportParse';

const PROGRAM = 'Sp1itter1111111111111111111111111111111111';
const VAULT = 'Vau1t11111111111111111111111111111111111111';
const VAULT_USDC = 'Vau1tUsdc111111111111111111111111111111111';
const accounts = { programId: PROGRAM, vault: VAULT, vaultUsdc: VAULT_USDC };
const DONOR = 'Donor111111111111111111111111111111111111111';
const DONOR2 = 'Donor222222222222222222222222222222222222222';
const PAYER = 'FeePayer11111111111111111111111111111111111';
const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const transfer = (source: string, destination: string, lamports: number) => ({ program: 'system', programId: '11111111111111111111111111111111', parsed: { type: 'transfer', info: { source, destination, lamports } } });
const tokenTransfer = (authority: string, amount: string) => ({ program: 'spl-token', programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', parsed: { type: 'transferChecked', info: { source: 'Src', destination: VAULT_USDC, authority, mint: MINT, tokenAmount: { amount, decimals: 6 } } } });
const memo = (text: string) => ({ program: 'spl-memo', programId: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', parsed: text });
const paidLog = (asset: 0 | 1, side: 0 | 1, amount: bigint) => {
  const bytes = new Uint8Array(8 + 1 + 1 + 8 + 32);
  bytes.set([240, 193, 17, 238, 238, 210, 129, 235]);
  bytes[8] = asset; bytes[9] = side;
  for (let i = 0; i < 8; i++) bytes[10 + i] = Number((amount >> BigInt(8 * i)) & 0xffn);
  return `Program data: ${Buffer.from(bytes).toString('base64')}`;
};

type Opts = { signers?: string[]; keys?: string[]; ixs?: unknown[]; inner?: unknown[]; sol?: [number, number]; usdc?: [string, string]; logs?: string[]; err?: unknown };
function tx({ signers = [PAYER], keys = [], ixs = [], inner = [], sol = [0, 0], usdc, logs = [], err = null }: Opts): RpcTransaction {
  const accountKeys = [...signers.map(pubkey => ({ pubkey, signer: true })), ...[VAULT, VAULT_USDC, ...keys].map(pubkey => ({ pubkey, signer: false }))];
  const vaultIndex = signers.length, usdcIndex = signers.length + 1;
  const pre = accountKeys.map(() => 1_000_000_000), post = [...pre];
  pre[vaultIndex] = sol[0]; post[vaultIndex] = sol[1];
  const balance = (amount: string) => [{ accountIndex: usdcIndex, mint: MINT, uiTokenAmount: { amount } }];
  return {
    slot: 10, blockTime: 1_700_000_000,
    meta: { err, preBalances: pre, postBalances: post, preTokenBalances: usdc ? balance(usdc[0]) : [], postTokenBalances: usdc ? balance(usdc[1]) : [], innerInstructions: inner.length ? [{ index: 0, instructions: inner as never }] : [], logMessages: logs },
    transaction: { signatures: ['Sig1'], message: { accountKeys, instructions: ixs as never } },
  };
}

describe('support memo', () => {
  it('reads the flags in order and bounds the note', () => {
    expect(parseSupportMemo('chainpay-support:v1')).toEqual({ anon: false, note: null });
    expect(parseSupportMemo('chainpay-support:v1 anon=1 note=thanks for the MCP tools')).toEqual({ anon: true, note: 'thanks for the MCP tools' });
    expect(parseSupportMemo('chainpay-support:v1 note=a\u0000b\nc\u007f')).toEqual({ anon: false, note: 'abc' });
    expect(parseSupportMemo(`chainpay-support:v1 note=${'x'.repeat(200)}`).note).toHaveLength(80);
    expect(parseSupportMemo('someone-else note=hi')).toEqual({ anon: false, note: null });
    expect(parseSupportMemo('chainpay-support:v1x note=hi')).toEqual({ anon: false, note: null });
  });
});

describe('parseSupportTx', () => {
  it('SOL contribution via a top-level transfer, donor is the source not the fee payer', () => {
    const r = parseSupportTx(tx({ signers: [PAYER, DONOR], ixs: [transfer(DONOR, VAULT, 5_000), memo('chainpay-support:v1 note=gm')], sol: [2_000_000, 2_005_000] }), accounts)!;
    expect(r.events).toEqual([{ kind: 'contribution', asset: 'SOL', amount: '5000', donor: DONOR, note: 'gm', side: null }]);
  });

  it('SOL contribution via an inner instruction', () => {
    const r = parseSupportTx(tx({ signers: [DONOR], inner: [transfer(DONOR, VAULT, 7)], sol: [10, 17] }), accounts)!;
    expect(r.events).toEqual([{ kind: 'contribution', asset: 'SOL', amount: '7', donor: DONOR, note: null, side: null }]);
  });

  it('USDC contribution via transferChecked, anon hides the signer', () => {
    const r = parseSupportTx(tx({ signers: [DONOR], ixs: [tokenTransfer(DONOR, '2500000'), memo('chainpay-support:v1 anon=1 note=hi')], usdc: ['0', '2500000'] }), accounts)!;
    expect(r.events).toEqual([{ kind: 'contribution', asset: 'USDC', amount: '2500000', donor: null, note: 'hi', side: null }]);
  });

  it('a memo with no transfer counts for nothing', () => {
    const r = parseSupportTx(tx({ signers: [DONOR], ixs: [memo('chainpay-support:v1 note=I gave 1000 SOL')], sol: [10, 10] }), accounts)!;
    expect(r.events).toEqual([]);
  });

  it('a transfer instruction larger than the balance change is not believed', () => {
    const r = parseSupportTx(tx({ signers: [DONOR], ixs: [transfer(DONOR, VAULT, 1_000_000)], sol: [10, 15] }), accounts)!;
    expect(r.events).toEqual([{ kind: 'contribution', asset: 'SOL', amount: '5', donor: null, note: null, side: null }]);
  });

  it('failed transactions are ignored', () => {
    expect(parseSupportTx(tx({ signers: [DONOR], ixs: [transfer(DONOR, VAULT, 5)], sol: [10, 15], err: { InstructionError: [0, 'Custom'] } }), accounts)).toBeNull();
    expect(parseSupportTx(null, accounts)).toBeNull();
  });

  it('payouts are classified by the splitter event, not as contributions', () => {
    const logs = [`Program ${PROGRAM} invoke [1]`, paidLog(0, 0, 400n), `Program ${PROGRAM} success`];
    const sol = parseSupportTx(tx({ logs, sol: [1_000, 600] }), accounts)!;
    expect(sol.events).toEqual([{ kind: 'payout', asset: 'SOL', amount: '400', donor: null, note: null, side: 'A' }]);
    const usdcLogs = [`Program ${PROGRAM} invoke [1]`, paidLog(1, 1, 3n), `Program ${PROGRAM} success`];
    const usdc = parseSupportTx(tx({ logs: usdcLogs, usdc: ['10', '7'] }), accounts)!;
    expect(usdc.events).toEqual([{ kind: 'payout', asset: 'USDC', amount: '3', donor: null, note: null, side: 'B' }]);
  });

  it('a Paid log emitted by another program is ignored', () => {
    const logs = ['Program Fake111 invoke [1]', paidLog(0, 0, 400n), 'Program Fake111 success'];
    const r = parseSupportTx(tx({ logs, sol: [1_000, 1_000] }), accounts)!;
    expect(r.events).toEqual([]);
  });

  it('two donors in one transaction are recorded separately; only signers get the note', () => {
    const r = parseSupportTx(tx({ signers: [DONOR], keys: [DONOR2], ixs: [transfer(DONOR, VAULT, 3), transfer(DONOR2, VAULT, 4), memo('chainpay-support:v1 note=team')], sol: [0, 7] }), accounts)!;
    expect(r.events).toEqual([
      { kind: 'contribution', asset: 'SOL', amount: '3', donor: DONOR, note: 'team', side: null },
      { kind: 'contribution', asset: 'SOL', amount: '4', donor: DONOR2, note: null, side: null },
    ]);
  });

  it('initialize rent is funding, not a contribution', () => {
    const logs = [`Program ${PROGRAM} invoke [1]`, `Program data: ${Buffer.from([180, 43, 207, 2, 18, 71, 3, 75, 0]).toString('base64')}`, `Program ${PROGRAM} success`];
    const r = parseSupportTx(tx({ logs, sol: [0, 1_900_000] }), accounts)!;
    expect(r.events).toEqual([{ kind: 'funding', asset: 'SOL', amount: '1900000', donor: null, note: null, side: null }]);
  });
});

describe('cursor paging', () => {
  const sigs = (...names: string[]) => names.map(signature => ({ signature, err: null }));
  it('walks a backlog over several pages, then only fetches newer signatures', () => {
    let c: SupportCursor = { newest: null, pending: null };
    expect(planPage(c)).toEqual({});
    c = advanceCursor(c, sigs('s9', 's8'), 2);
    expect(c).toEqual({ newest: null, pending: { top: 's9', before: 's8' } });
    expect(planPage(c)).toEqual({ before: 's8' });
    c = advanceCursor(c, sigs('s7', 's6'), 2);
    expect(c.pending).toEqual({ top: 's9', before: 's6' });
    c = advanceCursor(c, sigs('s5'), 2);
    expect(c).toEqual({ newest: 's9', pending: null });
    expect(planPage(c)).toEqual({ until: 's9' });
  });
  it('recovers when more than a page arrived while it was down', () => {
    let c: SupportCursor = { newest: 's1', pending: null };
    c = advanceCursor(c, sigs('s6', 's5'), 2);
    expect(c).toEqual({ newest: 's1', pending: { top: 's6', before: 's5' } });
    expect(planPage(c)).toEqual({ before: 's5', until: 's1' });
    c = advanceCursor(c, sigs('s4', 's3'), 2);
    c = advanceCursor(c, sigs('s2'), 2);
    expect(c).toEqual({ newest: 's6', pending: null });
  });
  it('an empty page finishes the backlog or changes nothing', () => {
    expect(advanceCursor({ newest: 'a', pending: { top: 'z', before: 'm' } }, [], 2)).toEqual({ newest: 'z', pending: null });
    expect(advanceCursor({ newest: 'a', pending: null }, [], 2)).toEqual({ newest: 'a', pending: null });
  });
});

describe('summarize', () => {
  it('keeps exact totals and labels counts as contributions', () => {
    const row = (kind: StoredEvent['kind'], asset: StoredEvent['asset'], amount: string, slot: number, side: StoredEvent['side'] = null): StoredEvent => ({ kind, asset, amount, side, donor: null, note: null, signature: `s${slot}`, slot, blockTime: null });
    const s = summarize([row('contribution', 'SOL', '9007199254740993', 1), row('contribution', 'USDC', '5', 2), row('payout', 'SOL', '3', 3, 'A'), row('funding', 'SOL', '100', 0)], true);
    expect(s.totals.sol).toEqual({ contributed: '9007199254740993', paidA: '3', paidB: '0' });
    expect(s.contributionCount).toBe(2);
    expect(s.recent.map(r => r.signature)).toEqual(['s2', 's1']);
    expect(s.recentPayouts).toEqual([{ signature: 's3', asset: 'SOL', amount: '3', blockTime: null, side: 'A' }]);
  });
});

describe('support storage', () => {
  it('re-ingesting a signature replaces its rows instead of double counting', async () => {
    const { convexTest } = await import('convex-test');
    const { default: schema } = await import('./schema');
    const { internal } = await import('./_generated/api');
    const t = convexTest(schema, import.meta.glob(['./**/*.ts', '!./**/*.test.ts']));
    const events = [{ kind: 'contribution' as const, asset: 'SOL' as const, amount: '5', donor: DONOR, note: null, side: null }];
    await t.mutation(internal.support.upsert, { signature: 'Sig1', slot: 1, blockTime: null, events });
    await t.mutation(internal.support.upsert, { signature: 'Sig1', slot: 1, blockTime: null, events });
    const s = await t.query(internal.support.publicSummary, {});
    expect(s.contributionCount).toBe(1);
    expect(s.totals.sol.contributed).toBe('5');
    expect(s.live).toBe(false);
  });
});
