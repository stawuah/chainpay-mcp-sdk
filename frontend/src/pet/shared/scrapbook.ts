import type { PetMemoriesResult, PetMemory } from '../../../../shared/pet';
export function mergeMemories(current: PetMemory[], incoming: PetMemory[]) {
  return [...new Map([...current, ...incoming].map(entry => [entry.id, entry])).values()].sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
}
/** Keeps expanded pages while fresh first-page reads own current aggregates. */
export function createScrapbook(request: (path: string) => Promise<PetMemoriesResult>) {
  let state: PetMemoriesResult & { error: boolean; loading: boolean } = { memories: [], aggregates: [], nextBefore: null, error: false, loading: false };
  let generation = 0, expanded = false, paging = false;
  const listeners = new Set<() => void>();
  const update = (next: Partial<typeof state>) => { state = { ...state, ...next }; listeners.forEach(listener => listener()); };
  async function refresh() {
    const current = ++generation;
    try {
      const result = await request('memories?limit=12');
      if (current !== generation) return;
      // A long absence may add more than one page. Keep the refreshed cursor
      // until pagination bridges that gap, even if older pages are retained.
      const overlaps = result.memories.some(memory => state.memories.some(old => old.id === memory.id));
      update({ memories: mergeMemories(state.memories, result.memories), aggregates: result.aggregates,
        nextBefore: expanded && overlaps ? state.nextBefore : result.nextBefore, error: false });
    } catch { if (current === generation) update({ error: true }); }
  }
  async function more() {
    const cursor = state.nextBefore;
    if (cursor === null || paging) return;
    paging = true; expanded = true; update({ loading: true });
    try {
      const result = await request(`memories?limit=12&before=${cursor}`);
      // Pagination cannot replace newer first-page data or its aggregate totals.
      expanded = true;
      update({ memories: mergeMemories(result.memories, state.memories), nextBefore: state.nextBefore === cursor ? result.nextBefore : state.nextBefore, error: false });
    } catch { update({ error: true }); }
    finally { paging = false; update({ loading: false }); }
  }
  return { get: () => state, subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }, refresh, more };
}
