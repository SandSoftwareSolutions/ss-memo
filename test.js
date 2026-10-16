import assert from "node:assert/strict";
import { test } from "node:test";

import { createCache, memoize } from "./src/index.js";

const tick = () => new Promise((r) => setTimeout(r, 5));

test("a value is loaded once while fresh", async () => {
  let t = 0, calls = 0;
  const cache = createCache({ ttlMs: 100, now: () => t });
  const load = async () => ++calls;
  assert.equal(await cache.get("a", load), 1);
  assert.equal(await cache.get("a", load), 1);
  t = 99;
  assert.equal(await cache.get("a", load), 1);
  t = 100;
  assert.equal(await cache.get("a", load), 2);
});

test("simultaneous requests share one load", async () => {
  let calls = 0;
  const cache = createCache({ ttlMs: 1000 });
  const slow = async () => { calls++; await tick(); return "x"; };
  const results = await Promise.all([cache.get("k", slow), cache.get("k", slow), cache.get("k", slow)]);
  assert.deepEqual(results, ["x", "x", "x"]);
  assert.equal(calls, 1);
});

test("failures are not cached by default, and everyone waiting sees the failure", async () => {
  let calls = 0;
  const cache = createCache({ ttlMs: 1000 });
  const bad = async () => { calls++; await tick(); throw new Error("down"); };
  const outcomes = await Promise.allSettled([cache.get("k", bad), cache.get("k", bad)]);
  assert.deepEqual(outcomes.map((o) => o.status), ["rejected", "rejected"]);
  assert.equal(calls, 1);
  assert.equal(await cache.get("k", async () => "back"), "back");
});

test("errorTtlMs remembers a failure for a short while", async () => {
  let t = 0, calls = 0;
  const cache = createCache({ ttlMs: 1000, errorTtlMs: 50, now: () => t });
  const bad = async () => { calls++; throw new Error("down"); };
  await assert.rejects(cache.get("k", bad), /down/);
  await tick();
  await assert.rejects(cache.get("k", bad), /down/);
  assert.equal(calls, 1);
  t = 60;
  await assert.rejects(cache.get("k", bad), /down/);
  assert.equal(calls, 2);
});

test("stale-while-revalidate serves the old value and refreshes in the background", async () => {
  let t = 0, calls = 0;
  const cache = createCache({ ttlMs: 100, staleMs: 400, now: () => t });
  const load = async () => `v${++calls}`;
  assert.equal(await cache.get("a", load), "v1");
  t = 150;
  assert.equal(await cache.get("a", load), "v1"); // stale, refresh started
  await tick();
  assert.equal(await cache.get("a", load), "v2");
  assert.equal(calls, 2);
  t = 1000; // too old even for stale
  assert.equal(await cache.get("a", load), "v3");
});

test("a failing background refresh keeps serving the stale value", async () => {
  let t = 0, fail = false;
  const cache = createCache({ ttlMs: 100, staleMs: 1000, now: () => t });
  const load = async () => { if (fail) throw new Error("down"); return "v1"; };
  await cache.get("a", load);
  fail = true;
  t = 150;
  assert.equal(await cache.get("a", load), "v1");
  await tick();
  assert.equal(await cache.get("a", load), "v1");
});

test("least recently used entries go first", async () => {
  const cache = createCache({ ttlMs: 1000, max: 2 });
  await cache.get("a", () => 1);
  await cache.get("b", () => 2);
  await cache.get("a", () => 1); // a is now the most recent
  await cache.get("c", () => 3);
  assert.equal(cache.peek("a"), 1);
  assert.equal(cache.peek("b"), undefined);
  assert.equal(cache.size, 2);
});

test("set, peek, delete, clear", async () => {
  const cache = createCache({ ttlMs: 1000 });
  cache.set("a", 1);
  assert.equal(cache.peek("a"), 1);
  assert.equal(await cache.get("a", () => 99), 1);
  assert.equal(cache.delete("a"), true);
  assert.equal(await cache.get("a", () => 99), 99);
  cache.clear();
  assert.equal(cache.size, 0);
});

test("memoize caches by arguments, also for sync functions", async () => {
  let calls = 0;
  const square = memoize((n) => { calls++; return n * n; });
  assert.equal(await square(4), 16);
  assert.equal(await square(4), 16);
  assert.equal(await square(5), 25);
  assert.equal(calls, 2);
  square.cache.clear();
  await square(4);
  assert.equal(calls, 3);
  const byId = memoize((user) => user.id, { key: (user) => String(user.id), ttlMs: 10 });
  assert.equal(await byId({ id: 7 }), 7);
});

test("bad options", () => {
  assert.throws(() => createCache({}), RangeError);
  assert.throws(() => createCache({ ttlMs: 1, max: 0 }), RangeError);
  assert.throws(() => memoize("x"), TypeError);
  assert.rejects(createCache({ ttlMs: 1 }).get("a"), TypeError);
});
