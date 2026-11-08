/**
 * SQLite layer (better-sqlite3, WAL). Owned by the Lead.
 *
 * Call `initDb()` once at boot (index.ts) or per test with a temp path.
 * Every other helper uses that connection; calling one before `initDb()`
 * throws. All statements are parameterized.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { ModelMessage } from 'ai';
import { dataPaths } from './config.js';

export type DB = Database.Database;

// ─── Row types ──────────────────────────────────────────────────────────

export interface ThreadRow {
  threadTs: string;
  channelId: string;
  skillName: string | null;
  modelOverride: string | null;
  /** A04: the installed SDK's ModelMessage[]. */
  messages: ModelMessage[];
  updatedAt: number;
}

export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';

export interface ApprovalRow {
  id: string;
  approvalId: string;
  threadTs: string;
  channelId: string;
  toolName: string;
  toolArgs: unknown;
  status: ApprovalStatus;
  requestedBy: string | null;
  decidedBy: string | null;
  decidedAt: number | null;
  /** ts of the Slack message holding the Approve/Reject buttons, once posted. */
  messageTs: string | null;
  createdAt: number;
}

export type FollowupStatus = 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED' | 'CANCELLED';

export interface FollowupRow {
  id: string;
  threadTs: string;
  channelId: string;
  /** Epoch ms. */
  runAt: number;
  prompt: string;
  status: FollowupStatus;
  createdAt: number;
}

/** A13: approvals older than this can no longer be approved and are swept to EXPIRED. */
export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

// ─── Schema ─────────────────────────────────────────────────────────────

/** Append-only. Each entry runs once, tracked by PRAGMA user_version. */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE threads (
    thread_ts      TEXT PRIMARY KEY,
    channel_id     TEXT NOT NULL,
    skill_name     TEXT,
    model_override TEXT,
    messages_json  TEXT NOT NULL DEFAULT '[]',
    updated_at     INTEGER NOT NULL
  );

  -- A13: approval_id, requested_by, decided_by, decided_at; EXPIRED status
  CREATE TABLE pending_approvals (
    id             TEXT PRIMARY KEY,
    approval_id    TEXT NOT NULL UNIQUE,
    thread_ts      TEXT NOT NULL,
    channel_id     TEXT NOT NULL,
    tool_name      TEXT NOT NULL,
    tool_args_json TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'PENDING'
                   CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED')),
    requested_by   TEXT,
    decided_by     TEXT,
    decided_at     INTEGER,
    message_ts     TEXT,
    created_at     INTEGER NOT NULL
  );
  CREATE INDEX idx_approvals_status_created ON pending_approvals (status, created_at);
  CREATE INDEX idx_approvals_thread ON pending_approvals (thread_ts, status);

  -- A20: follow-ups survive restarts
  CREATE TABLE followups (
    id         TEXT PRIMARY KEY,
    thread_ts  TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    run_at     INTEGER NOT NULL,
    prompt     TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'PENDING'
               CHECK (status IN ('PENDING', 'RUNNING', 'DONE', 'FAILED', 'CANCELLED')),
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_followups_status_run_at ON followups (status, run_at);
  `,
];

// ─── Connection ─────────────────────────────────────────────────────────

let db: DB | undefined;

/**
 * Open (creating if needed) the database, apply pragmas and migrations, and
 * make it the connection every helper uses. Defaults to DATA_DIR/agent.db.
 * Pass ':memory:' for an in-memory DB. Calling it again closes the previous
 * connection first.
 */
export function initDb(dbPath: string = dataPaths().db): DB {
  closeDb();
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const conn = new Database(dbPath);
  conn.pragma('journal_mode = WAL');
  conn.pragma('synchronous = NORMAL');
  conn.pragma('foreign_keys = ON');
  conn.pragma('busy_timeout = 5000');
  migrate(conn);
  db = conn;
  return conn;
}

export function getDb(): DB {
  if (!db) throw new Error('Database not initialized: call initDb() first');
  return db;
}

export function closeDb(): void {
  if (db?.open) db.close();
  db = undefined;
}

function migrate(conn: DB): void {
  const current = conn.pragma('user_version', { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    conn.transaction(() => {
      conn.exec(MIGRATIONS[v]!);
      conn.pragma(`user_version = ${v + 1}`);
    })();
  }
}

// ─── Settings ───────────────────────────────────────────────────────────

const DEFAULT_MODEL_KEY = 'default_model';

export function getSetting(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string | null): void {
  if (value === null) {
    getDb().prepare('DELETE FROM settings WHERE key = ?').run(key);
  } else {
    getDb()
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }
}

/**
 * The global model set via `/model`, or null when none is set.
 * Deliberately not seeded from env: null means "use env.DEFAULT_MODEL", so
 * editing .env keeps working after first boot (llm.resolveModel applies the fallback).
 */
export function getGlobalModel(): string | null {
  return getSetting(DEFAULT_MODEL_KEY);
}

/** Pass null to clear the override and fall back to env.DEFAULT_MODEL. */
export function setGlobalModel(modelId: string | null): void {
  setSetting(DEFAULT_MODEL_KEY, modelId);
}

// ─── Threads ────────────────────────────────────────────────────────────

interface ThreadDbRow {
  thread_ts: string;
  channel_id: string;
  skill_name: string | null;
  model_override: string | null;
  messages_json: string;
  updated_at: number;
}

function toThread(r: ThreadDbRow): ThreadRow {
  return {
    threadTs: r.thread_ts,
    channelId: r.channel_id,
    skillName: r.skill_name,
    modelOverride: r.model_override,
    messages: JSON.parse(r.messages_json) as ModelMessage[],
    updatedAt: r.updated_at,
  };
}

export function getThread(threadTs: string): ThreadRow | undefined {
  const r = getDb().prepare('SELECT * FROM threads WHERE thread_ts = ?').get(threadTs) as ThreadDbRow | undefined;
  return r ? toThread(r) : undefined;
}

/**
 * Create the thread row if it doesn't exist (empty history); never modifies
 * an existing row. Returns the row as stored.
 */
export function ensureThread(t: { threadTs: string; channelId: string; skillName?: string | null }): ThreadRow {
  getDb()
    .prepare(
      `INSERT INTO threads (thread_ts, channel_id, skill_name, messages_json, updated_at)
       VALUES (?, ?, ?, '[]', ?)
       ON CONFLICT (thread_ts) DO NOTHING`,
    )
    .run(t.threadTs, t.channelId, t.skillName ?? null, Date.now());
  return getThread(t.threadTs)!;
}

/**
 * Upsert a thread's history. `skillName` is only written when provided
 * (an existing skill link is never cleared); `model_override` is untouched.
 */
export function saveThread(t: {
  threadTs: string;
  channelId: string;
  messages: ModelMessage[];
  skillName?: string | null;
}): void {
  getDb()
    .prepare(
      `INSERT INTO threads (thread_ts, channel_id, skill_name, messages_json, updated_at)
       VALUES (@threadTs, @channelId, @skillName, @messagesJson, @now)
       ON CONFLICT (thread_ts) DO UPDATE SET
         channel_id    = excluded.channel_id,
         skill_name    = COALESCE(excluded.skill_name, threads.skill_name),
         messages_json = excluded.messages_json,
         updated_at    = excluded.updated_at`,
    )
    .run({
      threadTs: t.threadTs,
      channelId: t.channelId,
      skillName: t.skillName ?? null,
      messagesJson: JSON.stringify(t.messages),
      now: Date.now(),
    });
}

/** Set (or clear with null) a thread's model override. Returns false if the thread doesn't exist. */
export function setThreadModel(threadTs: string, modelId: string | null): boolean {
  const res = getDb()
    .prepare('UPDATE threads SET model_override = ?, updated_at = ? WHERE thread_ts = ?')
    .run(modelId, Date.now(), threadTs);
  return res.changes === 1;
}

// ─── Approvals (A03, A13) ───────────────────────────────────────────────

interface ApprovalDbRow {
  id: string;
  approval_id: string;
  thread_ts: string;
  channel_id: string;
  tool_name: string;
  tool_args_json: string;
  status: ApprovalStatus;
  requested_by: string | null;
  decided_by: string | null;
  decided_at: number | null;
  message_ts: string | null;
  created_at: number;
}

function toApproval(r: ApprovalDbRow): ApprovalRow {
  return {
    id: r.id,
    approvalId: r.approval_id,
    threadTs: r.thread_ts,
    channelId: r.channel_id,
    toolName: r.tool_name,
    toolArgs: JSON.parse(r.tool_args_json) as unknown,
    status: r.status,
    requestedBy: r.requested_by,
    decidedBy: r.decided_by,
    decidedAt: r.decided_at,
    messageTs: r.message_ts,
    createdAt: r.created_at,
  };
}

export function createApproval(a: {
  /** Defaults to a fresh UUID. */
  id?: string;
  approvalId: string;
  threadTs: string;
  channelId: string;
  toolName: string;
  toolArgs: unknown;
  requestedBy?: string | null;
  /** Epoch ms; defaults to now. */
  createdAt?: number;
}): ApprovalRow {
  const id = a.id ?? randomUUID();
  getDb()
    .prepare(
      `INSERT INTO pending_approvals
         (id, approval_id, thread_ts, channel_id, tool_name, tool_args_json, status, requested_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`,
    )
    .run(
      id,
      a.approvalId,
      a.threadTs,
      a.channelId,
      a.toolName,
      JSON.stringify(a.toolArgs ?? null),
      a.requestedBy ?? null,
      a.createdAt ?? Date.now(),
    );
  return getApproval(id)!;
}

export function getApproval(id: string): ApprovalRow | undefined {
  const r = getDb().prepare('SELECT * FROM pending_approvals WHERE id = ?').get(id) as ApprovalDbRow | undefined;
  return r ? toApproval(r) : undefined;
}

export function getApprovalByApprovalId(approvalId: string): ApprovalRow | undefined {
  const r = getDb().prepare('SELECT * FROM pending_approvals WHERE approval_id = ?').get(approvalId) as
    | ApprovalDbRow
    | undefined;
  return r ? toApproval(r) : undefined;
}

/** PENDING approvals, oldest first; optionally only for one thread. */
export function listPendingApprovals(threadTs?: string): ApprovalRow[] {
  const rows = (
    threadTs === undefined
      ? getDb().prepare(`SELECT * FROM pending_approvals WHERE status = 'PENDING' ORDER BY created_at`).all()
      : getDb()
          .prepare(`SELECT * FROM pending_approvals WHERE status = 'PENDING' AND thread_ts = ? ORDER BY created_at`)
          .all(threadTs)
  ) as ApprovalDbRow[];
  return rows.map(toApproval);
}

/** Record the ts of the Slack message carrying the buttons, so it can be updated later. */
export function setApprovalMessageTs(id: string, messageTs: string): boolean {
  return getDb().prepare('UPDATE pending_approvals SET message_ts = ? WHERE id = ?').run(messageTs, id).changes === 1;
}

/**
 * A13: atomically decide a PENDING approval. Returns true only for the single
 * call that changed the row; a double-click, an already-decided row, an
 * unknown id or an approval older than APPROVAL_TTL_MS all return false.
 * Continue the agent turn only when this returns true.
 */
export function resolveApproval(id: string, approved: boolean, decidedBy: string, now: number = Date.now()): boolean {
  const res = getDb()
    .prepare(
      `UPDATE pending_approvals
          SET status = ?, decided_by = ?, decided_at = ?
        WHERE id = ? AND status = 'PENDING' AND created_at > ?`,
    )
    .run(approved ? 'APPROVED' : 'REJECTED', decidedBy, now, id, now - APPROVAL_TTL_MS);
  return res.changes === 1;
}

/** A13: mark PENDING approvals older than maxAgeMs as EXPIRED. Returns the rows that changed. */
export function expireOldApprovals(maxAgeMs: number = APPROVAL_TTL_MS, now: number = Date.now()): ApprovalRow[] {
  const rows = getDb()
    .prepare(
      `UPDATE pending_approvals
          SET status = 'EXPIRED', decided_at = ?
        WHERE status = 'PENDING' AND created_at <= ?
        RETURNING *`,
    )
    .all(now, now - maxAgeMs) as ApprovalDbRow[];
  return rows.map(toApproval);
}

// ─── Follow-ups (A20) ───────────────────────────────────────────────────

interface FollowupDbRow {
  id: string;
  thread_ts: string;
  channel_id: string;
  run_at: number;
  prompt: string;
  status: FollowupStatus;
  created_at: number;
}

function toFollowup(r: FollowupDbRow): FollowupRow {
  return {
    id: r.id,
    threadTs: r.thread_ts,
    channelId: r.channel_id,
    runAt: r.run_at,
    prompt: r.prompt,
    status: r.status,
    createdAt: r.created_at,
  };
}

export function createFollowup(f: {
  id?: string;
  threadTs: string;
  channelId: string;
  /** Epoch ms. */
  runAt: number;
  prompt: string;
}): FollowupRow {
  const id = f.id ?? randomUUID();
  getDb()
    .prepare(
      `INSERT INTO followups (id, thread_ts, channel_id, run_at, prompt, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'PENDING', ?)`,
    )
    .run(id, f.threadTs, f.channelId, f.runAt, f.prompt, Date.now());
  return getFollowup(id)!;
}

export function getFollowup(id: string): FollowupRow | undefined {
  const r = getDb().prepare('SELECT * FROM followups WHERE id = ?').get(id) as FollowupDbRow | undefined;
  return r ? toFollowup(r) : undefined;
}

/** PENDING follow-ups ordered by run_at (including ones already due). */
export function listPendingFollowups(): FollowupRow[] {
  const rows = getDb()
    .prepare(`SELECT * FROM followups WHERE status = 'PENDING' ORDER BY run_at`)
    .all() as FollowupDbRow[];
  return rows.map(toFollowup);
}

/** Allowed transitions; anything else is a no-op that returns false. */
const FOLLOWUP_FROM: Record<Exclude<FollowupStatus, 'PENDING'>, FollowupStatus[]> = {
  RUNNING: ['PENDING'],
  DONE: ['PENDING', 'RUNNING'],
  FAILED: ['PENDING', 'RUNNING'],
  CANCELLED: ['PENDING'],
};

/**
 * Atomically move a follow-up to `status`. Returns true only if this call
 * changed it. Fire a follow-up only after `markFollowup(id, 'RUNNING')`
 * returns true; that claim prevents double-firing. Delivery is at-most-once:
 * a row left RUNNING by a crash is not retried.
 */
export function markFollowup(id: string, status: Exclude<FollowupStatus, 'PENDING'>): boolean {
  const from = FOLLOWUP_FROM[status];
  const res = getDb()
    .prepare(`UPDATE followups SET status = ? WHERE id = ? AND status IN (${from.map(() => '?').join(', ')})`)
    .run(status, id, ...from);
  return res.changes === 1;
}
