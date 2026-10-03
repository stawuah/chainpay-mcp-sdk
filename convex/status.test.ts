import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { convexTest } from 'convex-test';
import schema from './schema';
import { internal } from './_generated/api';
import { dayLevel, overallState, recentDays, uptimeRatio, STALE_MS } from '../shared/status';

const modules = import.meta.glob(['./**/*.ts', '!./**/*.test.ts']);
const NOW = Date.UTC(2026, 9, 3, 12);

function stubNetwork(down: Set<string> = new Set()) {
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input);
    const which = url.includes('relay') ? 'relay' : url.includes('mcp') ? 'mcp' : url.includes('solana') ? (String(init?.body).includes('getHealth') ? 'solana' : 'program') : 'web';
    if (down.has(which)) throw new Error(`${which} unreachable`);
    if (which === 'solana') return Response.json({ result: 'ok' });
    if (which === 'program') return Response.json({ result: { value: { executable: true } } });
    if (which === 'web') return new Response('<!doctype html>');
    return Response.json({ status: 'ok' });
  }));
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('status probes', () => {
  it('records one check per component and rolls them into today', async () => {
    const t = convexTest(schema, modules);
    stubNetwork();
    await t.action(internal.status.probe, {});
    stubNetwork(new Set(['relay']));
    await t.action(internal.status.probe, {});
    const summary = await t.query(internal.status.summary, { now: NOW });
    const relay = summary.components.find((c) => c.id === 'relay')!;
    expect(relay.state).toBe('down');
    expect(relay.days).toEqual([{ day: '2026-10-03', total: 2, up: 1, degraded: 0, down: 1 }]);
    expect(summary.components.find((c) => c.id === 'program')!.state).toBe('up');
    expect(overallState(summary.components, NOW)).toBe('partial');
  });

  it('retries once before calling a component down', async () => {
    const t = convexTest(schema, modules);
    stubNetwork();
    const healthy = globalThis.fetch;
    let relayCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
      if (String(input).includes('relay') && ++relayCalls === 1) throw new Error('blip');
      return healthy(input, init);
    }));
    await t.action(internal.status.probe, {});
    const summary = await t.query(internal.status.summary, { now: NOW });
    expect(relayCalls).toBe(2);
    expect(summary.components.find((c) => c.id === 'relay')!.state).toBe('up');
  });

  it('skips probing during maintenance', async () => {
    const t = convexTest(schema, modules);
    vi.stubEnv('CHAINPAY_MAINTENANCE', 'true');
    stubNetwork();
    await t.action(internal.status.probe, {});
    const summary = await t.query(internal.status.summary, { now: NOW });
    expect(summary.components.every((c) => c.state === null)).toBe(true);
  });

  it('prunes raw checks after a week and keeps the daily rollup', async () => {
    const t = convexTest(schema, modules);
    const old = NOW - 8 * 86_400_000;
    await t.mutation(internal.status.record, { at: old, results: [{ component: 'web', state: 'up', latencyMs: 100 }] });
    await t.mutation(internal.status.record, { at: NOW, results: [{ component: 'web', state: 'up', latencyMs: 100 }] });
    const rows = await t.run((ctx) => ctx.db.query('status_checks').collect());
    expect(rows).toHaveLength(1);
    const days = await t.run((ctx) => ctx.db.query('status_days').collect());
    expect(days).toHaveLength(2);
  });

  it('shows open incidents and their updates, and serves JSON publicly', async () => {
    const t = convexTest(schema, modules);
    const id = await t.mutation(internal.status.openIncident, { title: 'Relay slow', impact: 'minor', components: ['relay'], message: 'Looking into it.' });
    await t.mutation(internal.status.updateIncident, { id, state: 'resolved', message: 'Fixed.' });
    const response = await t.fetch('/status/v1');
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    const body = await response.json();
    expect(body.incidents[0].updates.map((u: { state: string }) => u.state)).toEqual(['investigating', 'resolved']);
    expect(body.incidents[0].resolvedAt).toBe(NOW);
  });
});

describe('status math', () => {
  it('grades days and overall state', () => {
    expect(dayLevel(undefined)).toBe('none');
    expect(dayLevel({ total: 288, up: 288, degraded: 0, down: 0 })).toBe('operational');
    expect(dayLevel({ total: 288, up: 280, degraded: 8, down: 0 })).toBe('degraded');
    expect(dayLevel({ total: 288, up: 287, degraded: 0, down: 1 })).toBe('partial');
    expect(dayLevel({ total: 288, up: 200, degraded: 0, down: 88 })).toBe('major');
    expect(uptimeRatio([])).toBeNull();
    expect(uptimeRatio([{ total: 4, up: 2, degraded: 1, down: 1 }])).toBe(0.75);
    expect(overallState([{ state: 'up', at: NOW - STALE_MS - 1 }], NOW)).toBe('unknown');
    expect(overallState([{ state: 'down', at: NOW }, { state: 'down', at: NOW }], NOW)).toBe('major');
    const days = recentDays(NOW);
    expect(days).toHaveLength(90);
    expect(days.at(-1)).toBe('2026-10-03');
  });
});
