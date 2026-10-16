export interface CacheOptions {
  /** How long a value is fresh. Default for `memoize`: forever. */
  ttlMs: number;
  /** After the ttl, serve the old value this much longer while a new one loads in the background. Default 0. */
  staleMs?: number;
  /** Most entries; least recently used go first. Default 1000. */
  max?: number;
  /** Remember a failure this long. Default 0 (failures are not cached). */
  errorTtlMs?: number;
  now?: () => number;
}

export interface Cache<K = string, V = unknown> {
  get(key: K, loader: () => V | Promise<V>): Promise<V>;
  set(key: K, value: V): void;
  peek(key: K): V | undefined;
  delete(key: K): boolean;
  clear(): void;
  readonly size: number;
}

export function createCache<K = string, V = unknown>(options: CacheOptions): Cache<K, V>;

export interface MemoizeOptions extends Partial<CacheOptions> {
  key?: (...args: any[]) => string;
}

export function memoize<A extends unknown[], R>(
  fn: (...args: A) => R | Promise<R>,
  options?: MemoizeOptions
): ((...args: A) => Promise<R>) & { cache: Cache<string, R> };
