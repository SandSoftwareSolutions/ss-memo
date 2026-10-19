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

// ---- review additions ----

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};

test("remembered failures count against max, so a flood of bad keys cannot grow the table", async () => {
  const cache = createCache({ ttlMs: 1000, max: 3, errorTtlMs: 60_000 });
  for (let i = 0; i < 50; i++) await assert.rejects(cache.get(`bad${i}`, async () => { throw new Error("down"); }));
  assert.ok(cache.size <= 3, `size ${cache.size}`);
});

test("entries that are still loading count against max too", async () => {
  const cache = createCache({ ttlMs: 1000, max: 3 });
  const pending = [];
  for (let i = 0; i < 10; i++) {
    const d = deferred();
    pending.push(d);
    cache.get(`k${i}`, () => d.promise).catch(() => {});
  }
  assert.ok(cache.size <= 3, `size ${cache.size}`);
  pending.forEach((d) => d.resolve(1));
  await tick();
  assert.ok(cache.size <= 3);
});

test("delete and clear win over a load that is still running", async () => {
  const cache = createCache({ ttlMs: 1000 });
  const a = deferred();
  const first = cache.get("k", () => a.promise);
  cache.delete("k");
  a.resolve("old");
  assert.equal(await first, "old"); // the caller who asked still gets its answer
  await tick();
  assert.equal(cache.peek("k"), undefined);
  assert.equal(cache.size, 0);
  const b = deferred();
  const second = cache.get("k", () => b.promise);
  cache.clear();
  b.resolve("old2");
  await second;
  await tick();
  assert.equal(cache.size, 0);
});

test("a failing load does not remove a value that was set while it ran", async () => {
  const cache = createCache({ ttlMs: 1000 });
  const d = deferred();
  const loading = cache.get("k", () => d.promise);
  cache.set("k", "manual");
  d.reject(new Error("down"));
  await assert.rejects(loading, /down/);
  await tick();
  assert.equal(cache.peek("k"), "manual");
});

test("a failed refresh keeps serving the stale value, also with errorTtlMs", async () => {
  let t = 0, calls = 0, fail = false;
  const cache = createCache({ ttlMs: 100, staleMs: 1000, errorTtlMs: 50, now: () => t });
  const load = async () => { calls++; if (fail) throw new Error("down"); return "v1"; };
  await cache.get("a", load);
  fail = true;
  t = 150;
  assert.equal(await cache.get("a", load), "v1");
  await tick();
  assert.equal(await cache.get("a", load), "v1"); // not an error
  assert.equal(calls, 2); // and the failing backend is left alone for errorTtlMs
  t = 220;
  assert.equal(await cache.get("a", load), "v1");
  await tick();
  assert.equal(calls, 3);
});

test("a thrown undefined is still a failure", async () => {
  const cache = createCache({ ttlMs: 1000, errorTtlMs: 1000 });
  let calls = 0;
  const bad = async () => { calls++; throw undefined; };
  await assert.rejects(cache.get("k", bad), (e) => e === undefined);
  await tick();
  await assert.rejects(cache.get("k", bad), (e) => e === undefined);
  assert.equal(calls, 1);
});

test("a clock that jumps back does not keep values alive", async () => {
  let t = 10_000, calls = 0;
  const cache = createCache({ ttlMs: 100, now: () => t });
  const load = async () => ++calls;
  await cache.get("a", load);
  t = 0;
  assert.equal(await cache.get("a", load), 2);
});

test("memoize tells apart arguments that JSON would merge", async () => {
  let calls = 0;
  const f = memoize((x) => { calls++; return String(x); });
  assert.equal(await f(undefined), "undefined");
  assert.equal(await f(null), "null");
  assert.equal(await f(NaN), "NaN");
  assert.equal(await f(Infinity), "Infinity");
  assert.equal(await f(null), "null");
  assert.equal(await f(10n), "10");
  assert.equal(await f(10), "10");
  assert.equal(await f({ a: undefined }), "[object Object]");
  assert.equal(await f({}), "[object Object]");
  assert.equal(calls, 8); // every call above is distinct except the second f(null)
});

test("memoize does not guess a key for arguments JSON cannot describe", async () => {
  const f = memoize((x) => x);
  await assert.rejects(f(new Map([[1, 2]])), TypeError);
  await assert.rejects(f(new Set([1])), TypeError);
  await assert.rejects(f(() => 1), TypeError);
  await assert.rejects(f(Symbol("s")), TypeError);
  const circular = {};
  circular.self = circular;
  await assert.rejects(f(circular), TypeError); // a rejection, not a throw
  const g = memoize((m) => m.size, { key: (m) => String(m.size) });
  assert.equal(await g(new Map([[1, 2]])), 1);
});
