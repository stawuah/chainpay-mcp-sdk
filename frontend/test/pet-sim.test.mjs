import test from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";
import { readFile } from "node:fs/promises";

async function load(relative) {
  const source = await readFile(new URL(relative, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
}

const sim = await load("../src/pet/sim/needs.ts");
const HOUR = 3_600_000;
// 2026-10-02 12:00 UTC: daytime, so decay runs at full speed.
const NOON = Date.UTC(2026, 9, 2, 12);

test("needs decay at the daytime rate", () => {
  const pet = sim.newPet(NOON);
  const later = sim.decay(pet, NOON + 2 * HOUR);
  assert.equal(later.needs.battery, 80 - 4 * 2);
  assert.equal(later.needs.joy, 70 - 6 * 2);
  assert.equal(later.needs.clean, 90 - 3 * 2);
  assert.equal(later.at, NOON + 2 * HOUR);
});

test("night hours decay at 0.3x and spans across dusk are split", () => {
  const dusk = Date.UTC(2026, 9, 2, 21);
  // 21:00 -> 23:00 is one awake hour and one sleeping hour.
  assert.ok(Math.abs(sim.weightedHours(dusk, dusk + 2 * HOUR) - 1.3) < 1e-9);
  assert.equal(sim.isNight(Date.UTC(2026, 9, 2, 22)), true);
  assert.equal(sim.isNight(Date.UTC(2026, 9, 2, 5, 59)), true);
  assert.equal(sim.isNight(Date.UTC(2026, 9, 2, 6)), false);
});

test("needs never go below zero and time never runs backwards", () => {
  const pet = sim.newPet(NOON);
  const gone = sim.decay(pet, NOON + 60 * 24 * HOUR);
  for (const need of sim.NEEDS) assert.equal(gone.needs[need], 0);
  assert.equal(sim.decay(gone, NOON).at, gone.at);
});

test("low power has hysteresis: enters under 15, leaves only above 35 on every need", () => {
  const pet = { ...sim.newPet(NOON), needs: { battery: 14, joy: 50, clean: 50 } };
  const low = sim.decay(pet, NOON + 1);
  assert.equal(low.lowPower, true);
  const fed = sim.applyAction(low, "feed", NOON + 2).snapshot; // battery 34
  assert.equal(fed.lowPower, true, "34 is not above 35, so he stays in low power");
  const later = { ...fed, needs: { ...fed.needs, battery: 36 } };
  assert.equal(sim.applyAction(later, "pet", NOON + 3).snapshot.lowPower, false);
});

test("care actions have cooldowns and report how long to wait", () => {
  const pet = sim.newPet(NOON);
  const first = sim.applyAction(pet, "feed", NOON);
  assert.equal(first.ok, true);
  const second = sim.applyAction(first.snapshot, "feed", NOON + 60_000);
  assert.equal(second.ok, false);
  assert.equal(second.retryMs, 9 * 60_000);
  assert.equal(sim.applyAction(first.snapshot, "feed", NOON + 10 * 60_000).ok, true);
});

test("poking him at night wakes him grumpy for a minute", () => {
  const night = Date.UTC(2026, 9, 2, 23);
  const pet = sim.newPet(night);
  assert.equal(sim.moodOf(pet, night), "asleep");
  const poked = sim.applyAction(pet, "poke", night).snapshot;
  assert.equal(sim.moodOf(poked, night + 30_000), "grumpy");
  assert.equal(sim.moodOf(poked, night + 61_000), "asleep");
});

test("stage follows age in days", () => {
  const day = 24 * HOUR;
  assert.equal(sim.stageFor(NOON, NOON), "boot");
  assert.equal(sim.stageFor(NOON, NOON + 3 * day), "sprout");
  assert.equal(sim.stageFor(NOON, NOON + 50 * day), "teen");
  assert.equal(sim.stageFor(NOON, NOON + 200 * day), "adult");
});
