import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ModelMessage } from 'ai';
import {
  APPROVAL_TTL_MS,
  closeDb,
  createApproval,
  createFollowup,
  ensureThread,
  expireOldApprovals,
  getApproval,
  getApprovalByApprovalId,
  getDb,
  getFollowup,
  getGlobalModel,
  getThread,
  initDb,
  listPendingApprovals,
  listPendingFollowups,
  markFollowup,
  resolveApproval,
  saveThread,
  setApprovalMessageTs,
  setGlobalModel,
  setThreadModel,
} from '../src/db.js';
import { setupTestEnv, type TestEnv } from './helpers/env.js';

let env: TestEnv;
beforeEach(async () => {
  env = await setupTestEnv();
});
afterEach(async () => {
  await env.cleanup();
});

const approvalInput = (over: Partial<Parameters<typeof createApproval>[0]> = {}) => ({
  approvalId: `aid-${Math.random().toString(36).slice(2)}`,
  threadTs: '1700000000.000100',
  channelId: 'C0TEST',
  toolName: 'bash',
  toolArgs: { command: 'rm -rf x' },
  requestedBy: 'U0ALLOWED1',
  ...over,
});

describe('connection and schema', () => {
  it('uses WAL and creates all tables', () => {
    expect(getDb().pragma('journal_mode', { simple: true })).toBe('wal');
    const tables = (getDb().prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]).map(
      (r) => r.name,
    );
    expect(tables).toEqual(expect.arrayContaining(['settings', 'threads', 'pending_approvals', 'followups']));
  });

  it('throws a clear error before initDb', () => {
    closeDb();
    expect(() => getGlobalModel()).toThrow(/initDb/);
  });

  it('migrations are idempotent across reopen', () => {
    setGlobalModel('anthropic:x');
    initDb(env.dbPath);
    initDb(env.dbPath);
    expect(getGlobalModel()).toBe('anthropic:x');
  });
});

describe('settings (llm precedence level 3)', () => {
  it('getGlobalModel is null until set and is NOT seeded from env', () => {
    process.env.DEFAULT_MODEL = 'anthropic:from-env';
    expect(getGlobalModel()).toBeNull();
    setGlobalModel('openai:gpt-5');
    expect(getGlobalModel()).toBe('openai:gpt-5');
    setGlobalModel(null);
    expect(getGlobalModel()).toBeNull();
  });
});

describe('threads', () => {
  const msgs: ModelMessage[] = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
  ];

  it('round-trips ModelMessage[] through messages_json (A04)', () => {
    saveThread({ threadTs: 't1', channelId: 'C1', messages: msgs });
    expect(getThread('t1')?.messages).toEqual(msgs);
    expect(getThread('nope')).toBeUndefined();
  });

  it('ensureThread never overwrites an existing row', () => {
    saveThread({ threadTs: 't1', channelId: 'C1', messages: msgs, skillName: 'morning-briefing' });
    const row = ensureThread({ threadTs: 't1', channelId: 'C9', skillName: 'other' });
    expect(row.messages).toEqual(msgs);
    expect(row.skillName).toBe('morning-briefing');
    expect(row.channelId).toBe('C1');
  });

  it('saveThread keeps an existing skill link and the model override', () => {
    saveThread({ threadTs: 't1', channelId: 'C1', messages: [], skillName: 'morning-briefing' });
    expect(setThreadModel('t1', 'openai:gpt-5')).toBe(true);
    saveThread({ threadTs: 't1', channelId: 'C1', messages: msgs });
    const row = getThread('t1')!;
    expect(row.skillName).toBe('morning-briefing');
    expect(row.modelOverride).toBe('openai:gpt-5');
    expect(row.messages).toEqual(msgs);
  });

  it('setThreadModel returns false for an unknown thread and clears with null', () => {
    expect(setThreadModel('missing', 'openai:gpt-5')).toBe(false);
    ensureThread({ threadTs: 't2', channelId: 'C1' });
    expect(setThreadModel('t2', 'openai:gpt-5')).toBe(true);
    expect(setThreadModel('t2', null)).toBe(true);
    expect(getThread('t2')?.modelOverride).toBeNull();
  });

  it('is parameterized: hostile thread ids and content are stored verbatim', () => {
    const evil = `x'); DROP TABLE threads; --`;
    saveThread({ threadTs: evil, channelId: evil, messages: [{ role: 'user', content: evil }] });
    expect(getThread(evil)?.messages[0]).toEqual({ role: 'user', content: evil });
    expect(getThread(evil)?.channelId).toBe(evil);
  });
});

describe('approvals (A13)', () => {
  it('creates PENDING rows with args and lookup by approvalId', () => {
    const a = createApproval(approvalInput({ approvalId: 'sdk-1' }));
    expect(a.status).toBe('PENDING');
    expect(a.toolArgs).toEqual({ command: 'rm -rf x' });
    expect(getApprovalByApprovalId('sdk-1')?.id).toBe(a.id);
    expect(listPendingApprovals('1700000000.000100').map((r) => r.id)).toEqual([a.id]);
    expect(listPendingApprovals('other-thread')).toEqual([]);
  });

  it('approvalId is unique', () => {
    createApproval(approvalInput({ approvalId: 'dup' }));
    expect(() => createApproval(approvalInput({ approvalId: 'dup' }))).toThrow();
  });

  it('resolve succeeds once; the double click returns false', () => {
    const a = createApproval(approvalInput());
    expect(resolveApproval(a.id, true, 'U0ALLOWED1')).toBe(true);
    expect(resolveApproval(a.id, true, 'U0ALLOWED1')).toBe(false);
    expect(resolveApproval(a.id, false, 'U0ALLOWED1')).toBe(false);
    const row = getApproval(a.id)!;
    expect(row.status).toBe('APPROVED');
    expect(row.decidedBy).toBe('U0ALLOWED1');
    expect(row.decidedAt).toBeTypeOf('number');
  });

  it('reject then approve: the approve returns false and status stays REJECTED', () => {
    const a = createApproval(approvalInput());
    expect(resolveApproval(a.id, false, 'U0ALLOWED1')).toBe(true);
    expect(resolveApproval(a.id, true, 'U0ALLOWED1')).toBe(false);
    expect(getApproval(a.id)?.status).toBe('REJECTED');
  });

  it('unknown id returns false', () => {
    expect(resolveApproval('does-not-exist', true, 'U0ALLOWED1')).toBe(false);
  });

  it('an approval older than 24h cannot be approved, even before the sweep', () => {
    const a = createApproval(approvalInput({ createdAt: Date.now() - APPROVAL_TTL_MS - 60_000 }));
    expect(resolveApproval(a.id, true, 'U0ALLOWED1')).toBe(false);
    expect(getApproval(a.id)?.status).toBe('PENDING');
  });

  it('expireOldApprovals marks only stale PENDING rows EXPIRED and returns them', () => {
    const old = createApproval(approvalInput({ createdAt: Date.now() - APPROVAL_TTL_MS - 1 }));
    const fresh = createApproval(approvalInput());
    const decidedOld = createApproval(approvalInput({ createdAt: Date.now() - APPROVAL_TTL_MS + 5_000 }));
    expect(resolveApproval(decidedOld.id, false, 'U0ALLOWED1')).toBe(true);

    const expired = expireOldApprovals();
    expect(expired.map((r) => r.id)).toEqual([old.id]);
    expect(expired[0]?.status).toBe('EXPIRED');
    expect(getApproval(old.id)?.status).toBe('EXPIRED');
    expect(getApproval(fresh.id)?.status).toBe('PENDING');
    expect(getApproval(decidedOld.id)?.status).toBe('REJECTED');
    expect(resolveApproval(old.id, true, 'U0ALLOWED1')).toBe(false);
    expect(expireOldApprovals()).toEqual([]);
  });

  it('records the Slack message ts for later chat.update', () => {
    const a = createApproval(approvalInput());
    expect(setApprovalMessageTs(a.id, '1800000000.000001')).toBe(true);
    expect(getApproval(a.id)?.messageTs).toBe('1800000000.000001');
    expect(setApprovalMessageTs('missing', 'x')).toBe(false);
  });
});

describe('followups (A20)', () => {
  it('claim with RUNNING succeeds once, then DONE; illegal transitions are no-ops', () => {
    const f = createFollowup({ threadTs: 't1', channelId: 'C1', runAt: Date.now() + 1000, prompt: 'check build' });
    expect(f.status).toBe('PENDING');
    expect(markFollowup(f.id, 'RUNNING')).toBe(true);
    expect(markFollowup(f.id, 'RUNNING')).toBe(false);
    expect(markFollowup(f.id, 'CANCELLED')).toBe(false);
    expect(markFollowup(f.id, 'DONE')).toBe(true);
    expect(markFollowup(f.id, 'FAILED')).toBe(false);
    expect(getFollowup(f.id)?.status).toBe('DONE');
  });

  it('lists only PENDING rows ordered by run_at', () => {
    const now = Date.now();
    const late = createFollowup({ threadTs: 't', channelId: 'C', runAt: now + 2000, prompt: 'b' });
    const early = createFollowup({ threadTs: 't', channelId: 'C', runAt: now - 2000, prompt: 'a' });
    const cancelled = createFollowup({ threadTs: 't', channelId: 'C', runAt: now, prompt: 'c' });
    expect(markFollowup(cancelled.id, 'CANCELLED')).toBe(true);
    expect(listPendingFollowups().map((f) => f.id)).toEqual([early.id, late.id]);
  });

  it('pending follow-ups survive closeDb()+initDb() on the same file (simulated restart)', () => {
    const f = createFollowup({ threadTs: 't', channelId: 'C', runAt: Date.now() + 60_000, prompt: 'later' });
    closeDb();
    initDb(env.dbPath);
    expect(listPendingFollowups().map((x) => x.id)).toEqual([f.id]);
    expect(getFollowup(f.id)?.prompt).toBe('later');
  });
});
