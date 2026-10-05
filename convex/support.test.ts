// Devnet-only support tracker (audit 2026-10-05 R4): the 5-minute cron's `sync`
// indexes only the configured Devnet vault, and refuses anything else.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { convexTest } from 'convex-test';
import schema from './schema';
import { internal } from './_generated/api';
import crons from './crons';

const modules = import.meta.glob(['./**/*.ts', '!./**/*.test.ts']);
const PROGRAM = 'D1DvnVq37696mcFB5JeVWZy22wjxZ5xPJmZazbfPK7BH';
const VAULT = '3yS1JFVT284y8z1LC9MRoWxZjzFrdoD5axKsZiyMsfC7';
const VAULT_USDC = '4iYFsZcZXQLTfykuzRwY19SxRja53Vm6jSf6CuTx6Kjt';
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const DEVNET_USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

type Chain = { genesis: string; vaultOwner: string | null; usdc: { mint: string; owner: string } | null };
const rpc = vi.fn();
let chain: Chain;
let calls: { method: string; params: unknown[] }[];

beforeEach(() => {
  vi.stubEnv('SUPPORT_CLUSTER', 'devnet');
  vi.stubEnv('SUPPORT_RPC_URL', 'https://tracker-rpc.invalid/?key=tracker');
  vi.stubEnv('SUPPORT_PROGRAM_ID', PROGRAM);
  vi.stubEnv('SUPPORT_VAULT', VAULT);
  vi.stubEnv('SUPPORT_VAULT_USDC', VAULT_USDC);
  chain = { genesis: DEVNET_GENESIS, vaultOwner: PROGRAM, usdc: { mint: DEVNET_USDC, owner: VAULT } };
  calls = [];
  rpc.mockReset();
  rpc.mockImplementation(async (_url: string, init: { body: string }) => {
    const { method, params } = JSON.parse(init.body);
    calls.push({ method, params });
    const result =
      method === 'getGenesisHash' ? chain.genesis
        : method === 'getAccountInfo' && params[0] === VAULT ? { value: chain.vaultOwner ? { owner: chain.vaultOwner } : null }
          : method === 'getAccountInfo' && params[0] === VAULT_USDC ? { value: chain.usdc ? { data: { parsed: { info: chain.usdc } } } : null }
            : method === 'getSignaturesForAddress' ? []
              : null;
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200 });
  });
  vi.stubGlobal('fetch', rpc);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('support tracker: Devnet only', () => {
  it('the five-minute cron runs support.sync', () => {
    const jobs = (crons as unknown as { crons: Record<string, { name: string; schedule: { type: string; minutes?: number } }> }).crons;
    const job = jobs['index support vault contributions'];
    expect(job).toBeDefined();
    expect(job.name).toBe('support:sync');
    expect(job.schedule).toMatchObject({ type: 'interval', minutes: 5 });
  });

  it('indexes exactly the configured vault and its USDC account on Devnet', async () => {
    const t = convexTest(schema, modules);
    expect(await t.action(internal.support.sync, {})).toEqual({ stored: 0 });
    const read = calls.filter((c) => c.method === 'getSignaturesForAddress').map((c) => c.params[0]);
    expect(read).toEqual([VAULT, VAULT_USDC]);
  });

  it('refuses to index when the RPC, vault, USDC account or cluster setting is wrong', async () => {
    const cases: [string, () => void][] = [
      ['mainnet RPC', () => { chain.genesis = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'; }],
      ['vault not owned by the program', () => { chain.vaultOwner = '11111111111111111111111111111111'; }],
      ['vault missing', () => { chain.vaultOwner = null; }],
      ['USDC account on mainnet USDC', () => { chain.usdc = { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', owner: VAULT }; }],
      ['USDC account owned by someone else', () => { chain.usdc = { mint: DEVNET_USDC, owner: PROGRAM }; }],
      ['USDC account missing', () => { chain.usdc = null; }],
      ['cluster setting mainnet', () => { vi.stubEnv('SUPPORT_CLUSTER', 'mainnet'); }],
      ['cluster setting absent', () => { vi.stubEnv('SUPPORT_CLUSTER', ''); }],
    ];
    for (const [name, breakIt] of cases) {
      chain = { genesis: DEVNET_GENESIS, vaultOwner: PROGRAM, usdc: { mint: DEVNET_USDC, owner: VAULT } };
      vi.stubEnv('SUPPORT_CLUSTER', 'devnet');
      calls = [];
      breakIt();
      const t = convexTest(schema, modules);
      expect(await t.action(internal.support.sync, {}), name).toEqual({ skipped: true });
      expect(calls.some((c) => c.method === 'getSignaturesForAddress'), name).toBe(false);
    }
  });

  it('SUPPORT_LIVE=false reports closed but does not stop the indexer', async () => {
    vi.stubEnv('SUPPORT_LIVE', 'false');
    const t = convexTest(schema, modules);
    expect(await t.action(internal.support.sync, {})).toEqual({ stored: 0 });
    expect((await t.query(internal.support.publicSummary, {})).live).toBe(false);
    vi.stubEnv('SUPPORT_LIVE', 'true');
    expect((await t.query(internal.support.publicSummary, {})).live).toBe(true);
    vi.stubEnv('SUPPORT_CLUSTER', 'mainnet');
    expect((await t.query(internal.support.publicSummary, {})).live).toBe(false);
  });
});
