/**
 * A small cache with a time limit that also protects the thing behind it: while a value is being loaded, everyone who asks
 * for it shares that one load ("single flight"), so ten simultaneous requests cause one database query, not ten.
 *
 * Options: `ttlMs` (how long a value is fresh), `staleMs` (after that, serve the old value while loading a new one in the
 * background, for this much longer; default 0), `max` (most entries; the least recently used go first), `errorTtlMs`
 * (remember a failure for a short while so a broken backend is not hammered; default 0 = failures are never cached),
 * `now` (for tests; the default is a clock that never jumps back). `delete`, `clear` and `set` win over a load that is still running: the callers waiting get their answer, but it is not stored. A failed background refresh keeps serving the old value.
 */
export function createCache({ ttlMs, staleMs = 0, max = 1000, errorTtlMs = 0, now = () => performance.now() } = {}) {
  if (typeof ttlMs !== "number" || Number.isNaN(ttlMs) || ttlMs < 0) throw new RangeError("createCache: ttlMs must be a number of milliseconds, 0 or more");
  if (typeof staleMs !== "number" || Number.isNaN(staleMs) || staleMs < 0) throw new RangeError("createCache: staleMs cannot be negative");
  if (!Number.isInteger(max) || max < 1) throw new RangeError("createCache: max must be a whole number of at least 1");
  const entries = new Map(); // key -> { value, hasValue, at, loading, error, hasError, errorAt }; also holds loads in flight and remembered failures

  const touch = (key, entry) => {
    entries.delete(key);
    entries.set(key, entry);
    while (entries.size > max) entries.delete(entries.keys().next().value);
  };

  // A step back of the clock gives a negative age; that counts as expired, never as "fresh for longer".
  const ageOf = (time, at) => (time - at >= 0 ? time - at : Infinity);
  const failedRecently = (entry, time) => entry.hasError && ageOf(time, entry.errorAt) < errorTtlMs;

  function load(key, loader, holder) {
    const promise = Promise.resolve().then(loader);
    holder.loading = promise;
    // Only the entry that is still in the table may be changed: delete(), clear() and set() during a load win over its result.
    promise.then(
      (value) => {
        holder.loading = undefined;
        if (entries.get(key) !== holder) return;
        holder.value = value;
        holder.hasValue = true;
        holder.at = now();
        holder.hasError = false;
        holder.error = undefined;
        touch(key, holder);
      },
      (error) => {
        holder.loading = undefined;
        if (entries.get(key) !== holder) return;
        if (errorTtlMs > 0) {
          holder.error = error;
          holder.hasError = true;
          holder.errorAt = now();
        } else if (!holder.hasValue) entries.delete(key);
      }
    );
    return promise;
  }

  return {
    /** The value for `key`, loading it with `loader` when it is missing or too old. */
    async get(key, loader) {
      if (typeof loader !== "function") throw new TypeError("cache.get: pass a loader function");
      const entry = entries.get(key);
      const time = now();
      if (entry?.hasValue) {
        const age = ageOf(time, entry.at);
        if (age < ttlMs) {
          touch(key, entry);
          return entry.value;
        }
        if (age < ttlMs + staleMs) {
          if (!entry.loading && !failedRecently(entry, time)) load(key, loader, entry).catch(() => {});
          touch(key, entry);
          return entry.value;
        }
      }
      if (entry?.loading) return entry.loading;
      if (entry && failedRecently(entry, time)) throw entry.error;
      const holder = {};
      const promise = load(key, loader, holder);
      touch(key, holder);
      return promise;
    },
    /** Put a value in by hand (for example after you wrote it yourself). */
    set(key, value) {
      touch(key, { value, hasValue: true, at: now() });
    },
    /** The fresh value or undefined; never loads. */
    peek(key) {
      const e = entries.get(key);
      return e?.hasValue && ageOf(now(), e.at) < ttlMs ? e.value : undefined;
    },
    delete: (key) => entries.delete(key),
    clear: () => entries.clear(),
    get size() {
      return entries.size;
    }
  };
}

/** JSON, but undefined, NaN, Infinity and bigint stay distinct from null and each other; what JSON cannot describe is refused. */
function defaultKey(...args) {
  return JSON.stringify(args, (_name, value) => {
    switch (typeof value) {
      case "undefined": return "\u0000undefined";
      case "bigint": return `\u0000${value}n`;
      case "number": return Number.isFinite(value) ? value : `\u0000${value}`;
      case "function":
      case "symbol": throw new TypeError("memoize: pass a `key` function when an argument is a function or symbol");
      default:
        if (value instanceof Map || value instanceof Set || value instanceof WeakMap || value instanceof WeakSet) throw new TypeError("memoize: pass a `key` function when an argument is a Map or Set");
        return value;
    }
  });
}

/**
 * Wraps a function (sync or async) in a cache. The key is built from the arguments with JSON by default; pass `key` for
 * arguments that JSON cannot describe. `fn.cache` is the cache underneath.
 */
export function memoize(fn, options = {}) {
  if (typeof fn !== "function") throw new TypeError("memoize: fn must be a function");
  const { key = defaultKey, ...cacheOptions } = options;
  const cache = createCache({ ttlMs: Infinity, ...cacheOptions });
  const wrapped = (...args) => {
    let k;
    try {
      k = key(...args);
    } catch (error) {
      return Promise.reject(error); // always a promise, also when the key cannot be made
    }
    return cache.get(k, () => fn(...args));
  };
  wrapped.cache = cache;
  return wrapped;
}
