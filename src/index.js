/**
 * A small cache with a time limit that also protects the thing behind it: while a value is being loaded, everyone who asks
 * for it shares that one load ("single flight"), so ten simultaneous requests cause one database query, not ten.
 *
 * Options: `ttlMs` (how long a value is fresh), `staleMs` (after that, serve the old value while loading a new one in the
 * background, for this much longer; default 0), `max` (most entries; the least recently used go first), `errorTtlMs`
 * (remember a failure for a short while so a broken backend is not hammered; default 0 = failures are never cached),
 * `now` (for tests).
 */
export function createCache({ ttlMs, staleMs = 0, max = 1000, errorTtlMs = 0, now = Date.now } = {}) {
  if (typeof ttlMs !== "number" || Number.isNaN(ttlMs) || ttlMs < 0) throw new RangeError("createCache: ttlMs must be a number of milliseconds, 0 or more");
  if (typeof staleMs !== "number" || Number.isNaN(staleMs) || staleMs < 0) throw new RangeError("createCache: staleMs cannot be negative");
  if (!Number.isInteger(max) || max < 1) throw new RangeError("createCache: max must be a whole number of at least 1");
  const entries = new Map(); // key -> { value, error, at, loading }

  const touch = (key, entry) => {
    entries.delete(key);
    entries.set(key, entry);
    while (entries.size > max) entries.delete(entries.keys().next().value);
  };

  function load(key, loader, entry) {
    const promise = Promise.resolve().then(loader);
    const holder = entry ?? {};
    holder.loading = promise;
    promise.then(
      (value) => {
        if (entries.get(key) === holder || !entries.has(key)) {
          holder.value = value;
          holder.error = undefined;
          holder.hasValue = true;
          holder.at = now();
          holder.loading = undefined;
          touch(key, holder);
        }
      },
      (error) => {
        holder.loading = undefined;
        if (errorTtlMs > 0) {
          holder.error = error;
          holder.errorAt = now();
        } else if (!holder.hasValue) entries.delete(key);
      }
    );
    return holder;
  }

  return {
    /** The value for `key`, loading it with `loader` when it is missing or too old. */
    async get(key, loader) {
      if (typeof loader !== "function") throw new TypeError("cache.get: pass a loader function");
      let entry = entries.get(key);
      if (entry) {
        if (entry.error !== undefined && now() - entry.errorAt < errorTtlMs) throw entry.error;
        if (entry.hasValue) {
          const age = now() - entry.at;
          if (age < ttlMs) {
            touch(key, entry);
            return entry.value;
          }
          if (age < ttlMs + staleMs) {
            if (!entry.loading) load(key, loader, entry).loading.catch(() => {});
            touch(key, entry);
            return entry.value;
          }
        }
        if (entry.loading) return entry.loading;
      }
      entry = load(key, loader, entry && !entry.hasValue ? entry : entry ? { ...entry, hasValue: false, value: undefined } : undefined);
      entries.set(key, entry);
      return entry.loading;
    },
    /** Put a value in by hand (for example after you wrote it yourself). */
    set(key, value) {
      touch(key, { value, hasValue: true, at: now() });
    },
    /** The fresh value or undefined; never loads. */
    peek(key) {
      const e = entries.get(key);
      return e?.hasValue && now() - e.at < ttlMs ? e.value : undefined;
    },
    delete: (key) => entries.delete(key),
    clear: () => entries.clear(),
    get size() {
      return entries.size;
    }
  };
}

/**
 * Wraps a function (sync or async) in a cache. The key is built from the arguments with JSON by default; pass `key` for
 * arguments that JSON cannot describe. `fn.cache` is the cache underneath.
 */
export function memoize(fn, options = {}) {
  if (typeof fn !== "function") throw new TypeError("memoize: fn must be a function");
  const { key = (...args) => JSON.stringify(args), ...cacheOptions } = options;
  const cache = createCache({ ttlMs: Infinity, ...cacheOptions });
  const wrapped = (...args) => cache.get(key(...args), () => fn(...args));
  wrapped.cache = cache;
  return wrapped;
}
