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

const s = await load("../src/pet/world/snakeSim.ts");
const seeded = (seed) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const run = (state, seconds, rand = seeded(9)) => {
  for (let i = 0; i < Math.round(seconds / s.STEP); i += 1) s.stepSnake(state, s.STEP, rand);
};
const fresh = (level = "normal", w = 480, h = 360) => {
  const st = s.createSnake(w, h, level, () => 0.1); // heading right on a wide field
  st.food = { x: -999, y: -999, vx: 0, vy: 0 }; // out of the way unless a test places it
  return st;
};

test("the queue drops reversals and repeats but keeps two quick turns", () => {
  const st = fresh();
  assert.equal(st.heading, 0);
  assert.equal(s.steer(st, "left"), false, "reverse");
  assert.equal(s.steer(st, "right"), false, "repeat");
  assert.equal(s.steer(st, "up"), true);
  assert.equal(s.steer(st, "left"), true, "a second turn in the same tick is kept");
  assert.equal(s.steer(st, "right"), false, "reverse of the last queued turn");
  run(st, 0.8);
  assert.ok(Math.abs(s.angleDiff(st.heading, Math.PI)) < 0.01, "ended heading left via up, never through the neck");
  assert.equal(st.status, "playing");
});

test("blob radius tapers from 10 to 7 over the last six", () => {
  assert.equal(s.blobRadius(0, 20), 10);
  assert.equal(s.blobRadius(13, 20), 10);
  assert.equal(s.blobRadius(19, 20), 7);
  assert.ok(s.blobRadius(16, 20) > 7 && s.blobRadius(16, 20) < 10);
});

test("blobs sit at fixed distances along the path", () => {
  const st = fresh();
  run(st, 0.5);
  const blobs = s.blobPositions(st);
  assert.equal(blobs.length, st.blobs);
  for (let i = 0; i < blobs.length; i += 1) {
    const expected = st.head.x - s.blobDistance(i);
    assert.ok(Math.abs(blobs[i].x - expected) < 0.6, `blob ${i} at ${blobs[i].x}, want ${expected}`);
    assert.ok(Math.abs(blobs[i].y - st.head.y) < 0.01);
  }
});

test("eating grows the tail, scores with the level multiplier and streak", () => {
  const st = fresh("normal");
  st.food = { x: st.head.x + 30, y: st.head.y, vx: 0, vy: 0 };
  run(st, 0.3);
  assert.equal(st.eaten, 1);
  assert.equal(st.blobs, s.START_BLOBS + s.BLOBS_PER_SPECK);
  assert.equal(st.score, 3, "normal: 3 points a speck");
  st.food = { x: st.head.x + 30, y: st.head.y, vx: 0, vy: 0 };
  run(st, 0.3);
  assert.equal(st.score, 3 + 3 + 1, "streak bonus inside 3s");
  assert.ok(Number.isInteger(st.score));
});

test("food is never placed on the body or right by the head", () => {
  for (let seed = 1; seed < 40; seed += 1) {
    const st = fresh();
    st.blobs = 40;
    run(st, 0.01);
    const f = s.placeFood(st, seeded(seed));
    for (const b of s.blobPositions(st)) assert.ok(Math.hypot(f.x - b.x, f.y - b.y) > s.BLOB_R + s.FOOD_R);
    assert.ok(Math.hypot(f.x - st.head.x, f.y - st.head.y) > 60);
    assert.ok(f.x >= 80 && f.x <= 400 && f.y >= 80 && f.y <= 280, "clear of kill walls");
  }
});

test("speed follows the curve per level and never passes the cap", () => {
  for (const level of ["chill", "normal", "spicy"]) {
    const c = s.LEVELS[level];
    assert.equal(s.speedFor(level, 0), c.base);
    assert.ok(Math.abs(s.speedFor(level, c.tau) - (c.base + (c.cap - c.base) * (1 - Math.exp(-1)))) < 1e-9);
    assert.ok(s.speedFor(level, 10_000) <= c.cap);
  }
  assert.ok(s.speedFor("spicy", 15) > s.speedFor("chill", 15) + 60, "spicy ramps clearly faster");
  // Constant turn radius: turn rate scales with speed.
  assert.equal(s.turnRateFor(200) / s.turnRateFor(100), 2);
});

test("chill wraps at the walls, normal and spicy end the run", () => {
  const chill = fresh("chill");
  run(chill, 4);
  assert.equal(chill.status, "playing");
  assert.ok(chill.head.x >= 0 && chill.head.x < 480);
  for (const level of ["normal", "spicy"]) {
    const st = fresh(level);
    run(st, 4);
    assert.equal(st.status, "over");
    assert.equal(st.cause, "wall");
  }
});

test("normal forgives an 80ms graze; a real hit still ends it", () => {
  const st = fresh("normal");
  st.head = { x: 480 - 5, y: 180 };
  st.hitSince = null;
  s.stepSnake(st);
  assert.equal(st.status, "playing", "first touch is forgiven");
  assert.ok(st.hitSince !== null);
  run(st, 0.1);
  assert.equal(st.status, "over");
});

test("the neck never counts and spawn grace stops early tail hits", () => {
  const st = fresh("chill");
  st.blobs = 60;
  run(st, 0.01);
  // Tight circle: the head crosses its own body.
  s.steer(st, "up");
  run(st, 0.4);
  s.steer(st, "left");
  run(st, 0.4);
  s.steer(st, "down");
  assert.equal(st.status, "playing", "inside the 1.5s grace");
  assert.ok(s.NECK >= 3);
  const late = fresh("chill");
  late.blobs = 60;
  run(late, 2); // past grace, long body laid along the path
  s.steer(late, "up");
  run(late, 0.3);
  s.steer(late, "left");
  run(late, 0.3);
  s.steer(late, "down");
  run(late, 1);
  assert.equal(late.status, "over");
  assert.equal(late.cause, "tail");
});

test("keys, swipes and relative turns map to directions", () => {
  assert.equal(s.keyDir("ArrowUp"), "up");
  assert.equal(s.keyDir("d"), "right");
  assert.equal(s.keyDir("x"), null);
  assert.equal(s.swipeDir(10, 5), null);
  assert.equal(s.swipeDir(-30, 5), "left");
  assert.equal(s.swipeDir(3, 40), "down");
  const st = fresh();
  assert.equal(s.relativeDir(st, "left"), "up");
  assert.equal(s.relativeDir(st, "right"), "down");
});

test("a tight U-turn never bites the tail (turn radius 16 > contact reach)", () => {
  const st = fresh("chill");
  st.blobs = 60;
  run(st, 2);
  s.steer(st, "up");
  s.steer(st, "left");
  run(st, 1.2);
  assert.equal(st.status, "playing");
  assert.ok(Math.abs(s.angleDiff(st.heading, Math.PI)) < 0.01);
});
