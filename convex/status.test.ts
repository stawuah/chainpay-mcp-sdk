import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { convexTest } from 'convex-test';
import schema from './schema';
import { internal } from './_generated/api';
import { coverage, currentState, dayLevel, expectedChecks, overallState, recentDays, uptimeRatio, STALE_MS } from '../shared/status';

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

describe('status review fixes', () => {
  it('F4 reopening a resolved incident moves it back to active', async () => {
    const t = convexTest(schema, modules);
    const id = await t.mutation(internal.status.openIncident, { title: 'Relay down', impact: 'major', components: ['relay'], message: 'x' });
    await t.mutation(internal.status.updateIncident, { id, state: 'resolved', message: 'fixed' });
    vi.setSystemTime(NOW + 60_000);
    await t.mutation(internal.status.updateIncident, { id, state: 'investigating', message: 'it is back' });
    const summary = await t.query(internal.status.summary, { now: NOW + 60_000 });
    expect(summary.incidents[0].resolvedAt).toBeNull();
  });

  it('F5 keeps an open incident when 20 newer ones exist', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.status.openIncident, { title: 'Still open', impact: 'major', components: ['relay'], message: 'x' });
    for (let i = 0; i < 25; i++) {
      vi.setSystemTime(NOW + (i + 1) * 1000);
      const id = await t.mutation(internal.status.openIncident, { title: `old ${i}`, impact: 'minor', components: ['web'], message: 'x' });
      await t.mutation(internal.status.updateIncident, { id, state: 'resolved', message: 'ok' });
    }
    const summary = await t.query(internal.status.summary, { now: NOW + 30_000 });
    expect(summary.incidents.some((i) => i.title === 'Still open' && i.resolvedAt === null)).toBe(true);
    expect(summary.incidents.length).toBeLessThanOrEqual(21);
    expect(summary.incidents.map((i) => i.startedAt)).toEqual([...summary.incidents.map((i) => i.startedAt)].sort((a, b) => b - a));
  });

  it('F6 an unreachable devnet RPC leaves the program unchecked, not down', async () => {
    const t = convexTest(schema, modules);
    stubNetwork(new Set(['solana', 'program']));
    await t.action(internal.status.probe, {});
    const summary = await t.query(internal.status.summary, { now: NOW });
    expect(summary.components.find((c) => c.id === 'solana')!.state).toBe('down');
    expect(summary.components.find((c) => c.id === 'program')!.state).toBeNull();
    expect(overallState(summary.components, NOW)).toBe('partial');
  });

  it('F6 a reachable RPC that says the program is missing still marks it down', async () => {
    const t = convexTest(schema, modules);
    stubNetwork();
    const healthy = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => String(init?.body ?? '').includes('getAccountInfo')
      ? Response.json({ result: { value: null } }) : healthy(input, init)));
    await t.action(internal.status.probe, {});
    const summary = await t.query(internal.status.summary, { now: NOW });
    expect(summary.components.find((c) => c.id === 'program')!.state).toBe('down');
  });

  it('F7 a timeout followed by a successful retry is recorded as slow, with the full wait', async () => {
    const t = convexTest(schema, modules);
    stubNetwork();
    const healthy = globalThis.fetch;
    let relayCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
      if (String(input).includes('relay') && ++relayCalls === 1) { vi.advanceTimersByTime(10_000); throw new DOMException('timeout', 'TimeoutError'); }
      return healthy(input, init);
    }));
    await t.action(internal.status.probe, {});
    const rows = await t.run((ctx) => ctx.db.query('status_checks').collect());
    const relay = rows.find((r) => r.component === 'relay')!;
    expect(relay.state).toBe('degraded');
    expect(relay.latencyMs).toBeGreaterThanOrEqual(10_000);
  });
});

describe('status math', () => {
  it('F1 a stale or missing check is unknown, never its last state', () => {
    expect(currentState({ state: 'up', at: NOW - 60_000 }, NOW)).toBe('up');
    expect(currentState({ state: 'up', at: NOW - STALE_MS - 1 }, NOW)).toBe('unknown');
    expect(currentState({ state: 'down', at: NOW - 3 * 86_400_000 }, NOW)).toBe('unknown');
    expect(currentState({ state: null, at: null }, NOW)).toBe('unknown');
    expect(currentState(undefined, NOW)).toBe('unknown');
  });

  it('F3 a day with gaps in sampling is partial data, not operational', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.status.record, { at: Date.UTC(2026, 9, 2, 0, 1), results: [{ component: 'relay', state: 'up', latencyMs: 50 }] });
    const summary = await t.query(internal.status.summary, { now: NOW });
    const day = summary.components.find((c) => c.id === 'relay')!.days[0];
    expect(dayLevel(day, expectedChecks(day.day, NOW))).toBe('gaps');
    // Known outages still show through gaps.
    expect(dayLevel({ total: 10, up: 9, degraded: 0, down: 1 }, 288)).toBe('major');
    expect(dayLevel({ total: 100, up: 100, degraded: 0, down: 0 }, 288)).toBe('gaps');
    expect(dayLevel({ total: 270, up: 270, degraded: 0, down: 0 }, 288)).toBe('operational');
  });

  it('F3 expected checks follow the elapsed part of today', () => {
    expect(expectedChecks('2026-10-02', NOW)).toBe(288);
    expect(expectedChecks('2026-10-03', NOW)).toBe(144);
    expect(expectedChecks('2026-10-03', Date.UTC(2026, 9, 3, 0, 3))).toBe(0);
    expect(expectedChecks('2026-10-04', NOW)).toBe(0);
    // Today, a little early in the day, one check is enough.
    expect(dayLevel({ total: 1, up: 1, degraded: 0, down: 0 }, expectedChecks('2026-10-03', Date.UTC(2026, 9, 3, 0, 12)))).toBe('operational');
  });

  it('F3 coverage counts unobserved time as unknown, not up', () => {
    const keys = recentDays(NOW, 3);
    const days = new Map([[keys[2], { total: 144, up: 144, degraded: 0, down: 0 }]]);
    expect(coverage(keys, days, NOW)).toBeCloseTo(144 / (288 * 2 + 144));
    const full = new Map(keys.map((k) => [k, { total: expectedChecks(k, NOW), up: expectedChecks(k, NOW), degraded: 0, down: 0 }]));
    expect(coverage(keys, full, NOW)).toBe(1);
    expect(coverage(keys, new Map([[keys[0], { total: 400, up: 400, degraded: 0, down: 0 }]]), NOW)).toBeCloseTo(288 / 720);
  });

  it('F6 a known outage shows even while another component is unknown', () => {
    expect(overallState([{ state: 'down', at: NOW }, { state: null, at: null }], NOW)).toBe('partial');
    expect(overallState([{ state: 'down', at: NOW }, { state: 'down', at: NOW }, { state: null, at: null }], NOW)).toBe('major');
    expect(overallState([{ state: 'up', at: NOW }, { state: null, at: null }], NOW)).toBe('unknown');
    expect(overallState([{ state: 'down', at: NOW - STALE_MS - 1 }, { state: 'up', at: NOW }], NOW)).toBe('unknown');
  });

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
