# @sandsoftwaresolutions/memo

[![CI](https://github.com/SandSoftwareSolutions/ss-memo/actions/workflows/ci.yml/badge.svg)](https://github.com/SandSoftwareSolutions/ss-memo/actions/workflows/ci.yml)

A small cache with a time limit that also protects what is behind it: ten simultaneous requests for the same thing cause **one** database query, not ten. Optional stale-while-revalidate, memory cap, and a short memory for failures. No dependencies.

## Install

```bash
npm install @sandsoftwaresolutions/memo
```

## Usage

```js
import { createCache, memoize } from "@sandsoftwaresolutions/memo";

const cache = createCache({ ttlMs: 60_000, staleMs: 5 * 60_000, max: 500 });

const user = await cache.get(`user:${id}`, () => db.loadUser(id));
// fresh for a minute; for 5 more minutes the old value is served at once while a new one loads in the background

// Or wrap a function:
const getRates = memoize(fetchRates, { ttlMs: 10 * 60_000 });
await getRates("EUR");  // arguments become the key (JSON); pass `key` for objects JSON cannot describe
```

## What it does

- **Single flight.** While a value is loading, every caller shares that one load, and all of them see the same result or the same error.
- **Failures are not cached** (default), so one bad moment does not stick. For a backend that is down, `errorTtlMs: 5000` remembers the failure for 5 seconds so you do not hammer it.
- **Stale while revalidate.** With `staleMs`, an expired value is still returned immediately and refreshed in the background. If that refresh fails, you keep getting the old value (with `errorTtlMs` the failing backend is also left alone for that long).
- **Memory cap.** `max` entries; the least recently used go first. Loads in flight and remembered failures count too, so a flood of bad keys cannot grow the table.
- **`delete`, `clear` and `set` win over a load that is still running.** The callers already waiting get their answer, but it is not stored, so an invalidation is not undone by a slow load.
- **Default keys of `memoize`** are the arguments as JSON, with `undefined`, `NaN`, `Infinity` and bigint kept apart from `null` and each other. Maps, Sets, functions and symbols as arguments are refused (the call rejects with a `TypeError`): pass `key`.
- **Clock.** The default clock never jumps back; if your own `now` does, the negative age counts as expired.
- A loader that never settles blocks that key for good (everyone shares its load): give your loader its own timeout.
- `cache.set`, `peek` (fresh value or `undefined`, never loads), `delete`, `clear`, `size`.
- `memoize(fn)` without options caches forever; `fn.cache` is the cache underneath, so you can clear it.

In memory, per process. A restart empties it, and two servers have two caches.
