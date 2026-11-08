/**
 * Per-test environment: a fresh temp DATA_DIR, a known process.env, a reset
 * config cache and (optionally) an initialized SQLite DB inside the temp dir.
 * Never touches the developer's real .env or ./data (vitest sets DOTENV_DISABLE=1).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataPaths, resetConfigCache, type DataPaths } from '../../src/config.js';
import { closeDb, initDb } from '../../src/db.js';

export const ALLOWED_USER = 'U0ALLOWED1';
export const OTHER_USER = 'U0EVIL999';

export const BASE_ENV: Record<string, string> = {
  SLACK_BOT_TOKEN: 'xoxb-test',
  SLACK_APP_TOKEN: 'xapp-test',
  ALLOWED_SLACK_USER_IDS: ALLOWED_USER,
  ANTHROPIC_API_KEY: 'test-key',
};

/** Every variable config.ts reads; cleared before each test so host values can't leak in. */
const MANAGED_KEYS = [
  'SLACK_BOT_TOKEN',
  'SLACK_APP_TOKEN',
  'SLACK_DEFAULT_CHANNEL',
  'ALLOWED_SLACK_USER_IDS',
  'DEFAULT_MODEL',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'OPENROUTER_API_KEY',
  'CUSTOM_BASE_URL',
  'CUSTOM_API_KEY',
  'TZ',
  'BASH_APPROVAL_MODE',
  'HISTORY_MAX_MESSAGES',
  'DATA_DIR',
];

/** Reset the managed env vars to BASE_ENV + overrides (undefined deletes) and drop the config cache. */
export function applyEnv(overrides: Record<string, string | undefined> = {}): void {
  for (const k of MANAGED_KEYS) delete process.env[k];
  const merged: Record<string, string | undefined> = { ...BASE_ENV, ...overrides };
  for (const [k, v] of Object.entries(merged)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetConfigCache();
}

export interface TestEnv {
  dataDir: string;
  dbPath: string;
  paths: DataPaths;
  cleanup(): Promise<void>;
}

export async function setupTestEnv(
  opts: { env?: Record<string, string | undefined>; db?: boolean } = {},
): Promise<TestEnv> {
  const snapshot = { ...process.env };
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openagent-test-'));
  applyEnv({ ...opts.env, DATA_DIR: dataDir });
  const dbPath = path.join(dataDir, 'agent.db');
  if (opts.db !== false) initDb(dbPath);
  return {
    dataDir,
    dbPath,
    paths: dataPaths(dataDir),
    async cleanup() {
      closeDb();
      for (const k of Object.keys(process.env)) if (!(k in snapshot)) delete process.env[k];
      Object.assign(process.env, snapshot);
      resetConfigCache();
      await rmDirWithRetry(dataDir);
    },
  };
}

/** Windows holds file handles (SQLite WAL, git) briefly after close; retry the delete. */
export async function rmDirWithRetry(dir: string): Promise<void> {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // Best effort: a leftover temp dir must not fail the test.
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const IS_WINDOWS = process.platform === 'win32';
export const IN_CONTAINER = Boolean(process.env.IN_CONTAINER);
