/**
 * A05: in-process async mutexes. One process is all we run.
 *
 * Locks are NOT re-entrant: calling withThreadLock(t, ...) from inside a
 * withThreadLock(t, ...) callback deadlocks. Never call runAgentTurn (which
 * takes the thread lock) from inside a tool's execute() for the same thread.
 */

class KeyedMutex {
  /** Tail of each key's queue. Removed when the queue drains, so the map never grows unbounded. */
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.tails.set(key, tail);

    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }

  /** True while any caller holds or waits for `key`. */
  isLocked(key: string): boolean {
    return this.tails.has(key);
  }
}

const threadLocks = new KeyedMutex();
const dataRepoLock = new KeyedMutex();
const DATA_REPO_KEY = 'data-repo';

/** Serialize all work on one Slack thread (load → generate → persist). */
export function withThreadLock<T>(threadTs: string, fn: () => Promise<T> | T): Promise<T> {
  return threadLocks.run(threadTs, fn);
}

/** A21: serialize every git operation and file write in ./data's git repo. */
export function withDataRepoLock<T>(fn: () => Promise<T> | T): Promise<T> {
  return dataRepoLock.run(DATA_REPO_KEY, fn);
}

/** Diagnostics/tests: whether a thread currently has a turn running or queued. */
export function isThreadLocked(threadTs: string): boolean {
  return threadLocks.isLocked(threadTs);
}
