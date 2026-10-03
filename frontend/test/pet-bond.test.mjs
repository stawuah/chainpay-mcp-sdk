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

const bond = await load("../src/pet/sim/bond.ts");
// Local noon avoids day-boundary surprises in any time zone.
const day = (d) => new Date(2026, 9, d, 12).getTime();

test("first visit, same-day revisit, streak and a broken streak", () => {
  let b = bond.newBond(day(1));
  let r = bond.visit(b, day(1));
  assert.equal(r.greeting, "first");
  assert.equal(r.bond.streak, 1);
  r = bond.visit(r.bond, day(1) + 3_600_000);
  assert.equal(r.greeting, "same-day");
  r = bond.visit(r.bond, day(2));
  assert.equal(r.greeting, "streak");
  assert.equal(r.bond.streak, 2);
  r = bond.visit(r.bond, day(5));
  assert.equal(r.greeting, "back");
  assert.equal(r.bond.streak, 1);
  assert.equal(r.bond.visitDays, 3);
});

test("xp levels and gear unlock automatically, and can be taken off", () => {
  let b = bond.newBond(day(1));
  assert.equal(bond.levelOf(b.xp).level, "stranger");
  for (let i = 0; i < 7; i++) b = bond.gain(b, "care", day(1)); // 21 xp
  assert.equal(bond.levelOf(b.xp).level, "regular");
  assert.deepEqual(b.gearOn, ["antenna"]);
  b = bond.toggleGear(b, "antenna");
  assert.deepEqual(b.gearOn, []);
  // Locked gear cannot be put on.
  assert.deepEqual(bond.toggleGear(b, "cap").gearOn, []);
});

test("daily xp cap and per-kind caps stop grinding; a new day resets them", () => {
  let b = bond.newBond(day(1));
  for (let i = 0; i < 20; i++) b = bond.gain(b, "pat", day(1));
  assert.equal(b.xp, 5, "pats stop paying after five a day");
  for (let i = 0; i < 30; i++) b = bond.gain(b, "call", day(1));
  assert.equal(b.xp, bond.DAILY_XP_CAP);
  b = bond.gain(b, "call", day(2));
  assert.equal(b.xp, bond.DAILY_XP_CAP + 5);
});

test("the diary closes yesterday's page from what actually happened", () => {
  let b = bond.newBond(day(1));
  b = bond.note(b, "fed", day(1), 2);
  b = bond.note(b, "specks", day(1), 3);
  assert.match(bond.todaySoFar(b).text, /charged 2 times|battery top-ups: 2/);
  b = bond.rollDay(b, day(2));
  assert.equal(b.diary.length, 1);
  assert.equal(b.diary[0].day, bond.dayKey(day(1)));
  assert.match(b.diary[0].text, /3 dust specks swept up/);
  assert.equal(bond.todaySoFar(b), null, "a new day starts empty");
  // A day with nothing in it leaves no page.
  assert.equal(bond.rollDay(b, day(4)).diary.length, 1);
});

test("secrets pay once", () => {
  let b = bond.newBond(day(1));
  let r = bond.findSecret(b, "konami", day(1));
  assert.equal(r.fresh, true);
  r = bond.findSecret(r.bond, "konami", day(1));
  assert.equal(r.fresh, false);
  assert.equal(r.bond.secretsFound.length, 1);
});
