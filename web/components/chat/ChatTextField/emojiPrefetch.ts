const DEFAULT_CONCURRENCY = 1;
const WARMUP_START_DELAY_MS = 2500;
const THREE_G_PREFETCH_LIMIT = 48 * 3;

type ConnectionInfo = {
  effectiveType?: string;
  saveData?: boolean;
  addEventListener?: (type: 'change', listener: () => void) => void;
  removeEventListener?: (type: 'change', listener: () => void) => void;
};

type NavigatorWithConnection = Navigator & {
  connection?: ConnectionInfo;
  mozConnection?: ConnectionInfo;
  webkitConnection?: ConnectionInfo;
};

type PrefetchTask = (url: string, signal?: AbortSignal) => Promise<void>;

const prefetchedUrls = new Set<string>();
const prefetchPromises = new Map<string, Promise<void>>();

function connectionInfo(): ConnectionInfo | undefined {
  if (typeof navigator === 'undefined') return undefined;
  const extendedNavigator = navigator as NavigatorWithConnection;
  return (
    extendedNavigator.connection ||
    extendedNavigator.mozConnection ||
    extendedNavigator.webkitConnection
  );
}

/** Return how many items may be warmed without direct user intent. */
export function backgroundPrefetchLimit(total: number, connection = connectionInfo()): number {
  if (connection?.saveData) return 0;

  switch (connection?.effectiveType) {
    case 'slow-2g':
    case '2g':
      return 0;
    case '3g':
      return Math.min(total, THREE_G_PREFETCH_LIMIT);
    default:
      return total;
  }
}

export function backgroundEmojiPrefetchAllowed(connection = connectionInfo()): boolean {
  return backgroundPrefetchLimit(1, connection) > 0;
}

async function isInCacheStorage(url: string): Promise<boolean> {
  if (typeof caches === 'undefined') return false;

  try {
    return Boolean(await caches.match(url));
  } catch {
    return false;
  }
}

/**
 * Fetch an emoji without decoding it. The service worker can put the response
 * into its dedicated image cache; without a service worker the HTTP cache is
 * still warmed. Calls for the same URL share one promise.
 */
export function prefetchEmojiUrl(url: string, signal?: AbortSignal): Promise<void> {
  if (!url || prefetchedUrls.has(url)) return Promise.resolve();

  const existing = prefetchPromises.get(url);
  if (existing) return existing;

  const task = (async () => {
    if (await isInCacheStorage(url)) {
      prefetchedUrls.add(url);
      return;
    }

    const response = await fetch(url, { credentials: 'same-origin', signal });
    if (!response.ok) throw new Error(`Unable to prefetch emoji: ${response.status}`);

    // Consume the response so the browser/service worker can finish caching it.
    await response.blob();
    prefetchedUrls.add(url);
  })().finally(() => {
    prefetchPromises.delete(url);
  });

  prefetchPromises.set(url, task);
  return task;
}

/**
 * Record an emoji URL that is already being loaded by a visible <img> (the
 * picker's viewport lazy loader), so background queues skip it and never
 * re-request what the user has already seen.
 */
export function markEmojiLoaded(url: string): void {
  if (url) prefetchedUrls.add(url);
}

export class EmojiPrefetchQueue {
  private readonly concurrency: number;

  private readonly task: PrefetchTask;

  private readonly pending: string[] = [];

  private readonly queued = new Set<string>();

  private active = 0;

  private readonly activeControllers = new Map<string, AbortController>();

  private paused = true;

  private destroyed = false;

  constructor(task: PrefetchTask = prefetchEmojiUrl, concurrency = DEFAULT_CONCURRENCY) {
    this.task = task;
    this.concurrency = concurrency;
  }

  enqueue(urls: string[], priority = false) {
    const next = urls.filter(url => url && !this.queued.has(url) && !prefetchedUrls.has(url));
    next.forEach(url => this.queued.add(url));

    if (priority) this.pending.unshift(...next);
    else this.pending.push(...next);

    this.drain();
  }

  clearPending() {
    this.pending.splice(0).forEach(url => this.queued.delete(url));
  }

  pause(cancelActive = false) {
    this.paused = true;
    if (cancelActive) {
      this.activeControllers.forEach(controller => controller.abort());
    }
  }

  resume() {
    if (this.destroyed) return;
    this.paused = false;
    this.drain();
  }

  destroy() {
    this.destroyed = true;
    this.pause(true);
    this.clearPending();
  }

  private drain() {
    while (!this.destroyed && !this.paused && this.active < this.concurrency) {
      const url = this.pending.shift();
      if (!url) return;

      this.active += 1;
      const controller = new AbortController();
      this.activeControllers.set(url, controller);
      let retry = false;
      this.task(url, controller.signal)
        .catch(() => {
          retry = !this.destroyed && controller.signal.aborted;
          // Prefetching is best-effort. A visible <img> can retry normally.
        })
        .finally(() => {
          if (this.activeControllers.get(url) === controller) {
            this.activeControllers.delete(url);
          }
          if (retry) {
            this.pending.unshift(url);
          } else {
            this.queued.delete(url);
          }
          this.active -= 1;
          this.drain();
        });
    }
  }
}

/** Warm a small, user-visible set immediately while preserving URL dedupe. */
export function prefetchPriorityEmoji(urls: string[], concurrency = 6): void {
  const queue = new EmojiPrefetchQueue(prefetchEmojiUrl, concurrency);
  queue.enqueue(Array.from(new Set(urls)), true);
  queue.resume();
}

/**
 * Start a slow, single-threaded background warm of the emoji grid once the
 * user has opened the picker for the first time (callers gate this). It is
 * deliberately independent of video playback: no media events, no stable-
 * playback window — it just trickles one image at a time into the HTTP cache
 * so the whole grid is eventually cached even when the player is never used.
 * Hidden-page, offline and constrained-network states pause the queue; all
 * listeners, in-flight fetches and timers are cleaned up by the returned
 * function.
 */
export function startEmojiWarmup(urls: string[]): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => undefined;

  const queue = new EmojiPrefetchQueue();
  const connection = connectionInfo();
  let warmupTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const limit = backgroundPrefetchLimit(urls.length, connection);

  const clearWarmupTimer = () => {
    if (warmupTimer !== undefined) clearTimeout(warmupTimer);
    warmupTimer = undefined;
  };

  const canRun = () =>
    !disposed && document.visibilityState !== 'hidden' && navigator.onLine !== false && limit > 0;

  const schedule = () => {
    clearWarmupTimer();
    if (!canRun()) return;
    // Small grace delay so the visible rows (IntersectionObserver) win over
    // the warmup queue when the picker first opens.
    warmupTimer = setTimeout(() => {
      warmupTimer = undefined;
      if (!canRun()) return;
      queue.enqueue(urls.slice(0, limit));
      queue.resume();
    }, WARMUP_START_DELAY_MS);
  };

  const pauseQueue = () => queue.pause();

  const onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') pauseQueue();
    else schedule();
  };

  const onOnline = () => schedule();

  const onConnectionChange = () => {
    queue.clearPending();
    schedule();
  };

  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', pauseQueue);
  connection?.addEventListener?.('change', onConnectionChange);

  schedule();

  return () => {
    disposed = true;
    pauseQueue();
    queue.destroy();
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('online', onOnline);
    window.removeEventListener('offline', pauseQueue);
    connection?.removeEventListener?.('change', onConnectionChange);
  };
}
