import { describe, expect, it } from 'vitest';
import { isThreadLocked, withDataRepoLock, withThreadLock } from '../src/locks.js';
import { sleep } from './helpers/env.js';

describe('withThreadLock (A05)', () => {
  it('serializes work on the same thread in arrival order', async () => {
    const log: string[] = [];
    const job = (name: string, ms: number) => async () => {
      log.push(`start ${name}`);
      await sleep(ms);
      log.push(`end ${name}`);
      return name;
    };
    const results = await Promise.all([
      withThreadLock('t1', job('a', 30)),
      withThreadLock('t1', job('b', 5)),
      withThreadLock('t1', job('c', 1)),
    ]);
    expect(results).toEqual(['a', 'b', 'c']);
    expect(log).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
  });

  it('lets different threads run concurrently', async () => {
    const log: string[] = [];
    await Promise.all([
      withThreadLock('t1', async () => {
        log.push('start 1');
        await sleep(30);
        log.push('end 1');
      }),
      withThreadLock('t2', async () => {
        log.push('start 2');
        await sleep(1);
        log.push('end 2');
      }),
    ]);
    expect(log.indexOf('start 2')).toBeLessThan(log.indexOf('end 1'));
  });

  it('releases the lock when fn throws (sync or async)', async () => {
    await expect(
      withThreadLock('t3', () => {
        throw new Error('sync boom');
      }),
    ).rejects.toThrow('sync boom');
    await expect(withThreadLock('t3', async () => Promise.reject(new Error('async boom')))).rejects.toThrow('async boom');
    await expect(withThreadLock('t3', () => 'ok')).resolves.toBe('ok');
    expect(isThreadLocked('t3')).toBe(false);
  });

  it('isThreadLocked is true while held or queued and false once drained', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const p1 = withThreadLock('t4', () => gate);
    const p2 = withThreadLock('t4', () => 'second');
    expect(isThreadLocked('t4')).toBe(true);
    release();
    await p1;
    await p2;
    expect(isThreadLocked('t4')).toBe(false);
  });

  it('does not lose read-modify-write updates under contention', async () => {
    let shared = 0;
    await Promise.all(
      Array.from({ length: 20 }, () =>
        withThreadLock('counter', async () => {
          const v = shared;
          await sleep(1);
          shared = v + 1;
        }),
      ),
    );
    expect(shared).toBe(20);
  });
});

describe('withDataRepoLock (A21)', () => {
  it('serializes all repo writers', async () => {
    let active = 0;
    let maxActive = 0;
    await Promise.all(
      Array.from({ length: 5 }, () =>
        withDataRepoLock(async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await sleep(5);
          active -= 1;
        }),
      ),
    );
    expect(maxActive).toBe(1);
  });
});
