import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ConfigError,
  configuredProviders,
  dataPaths,
  getConfig,
  parseConfig,
  resetConfigCache,
} from '../src/config.js';
import { BASE_ENV, applyEnv } from './helpers/env.js';

const SNAPSHOT = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in SNAPSHOT)) delete process.env[k];
  Object.assign(process.env, SNAPSHOT);
  resetConfigCache();
});

function issuesOf(env: Record<string, string | undefined>): string[] {
  try {
    parseConfig(env);
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return (e as ConfigError).issues;
  }
  throw new Error('expected parseConfig to throw');
}

describe('parseConfig', () => {
  it('accepts the minimal valid env and applies defaults', () => {
    const cfg = parseConfig({ ...BASE_ENV });
    expect(cfg.ALLOWED_SLACK_USER_IDS).toEqual(['U0ALLOWED1']);
    expect(cfg.BASH_APPROVAL_MODE).toBe('always'); // A08 default
    expect(cfg.HISTORY_MAX_MESSAGES).toBe(120); // A06 default
    expect(cfg.TZ).toBe('UTC');
    expect(cfg.DEFAULT_MODEL).toMatch(/^anthropic:/);
    expect(path.isAbsolute(cfg.DATA_DIR)).toBe(true);
  });

  it('A07: ALLOWED_SLACK_USER_IDS is required', () => {
    const env: Record<string, string | undefined> = { ...BASE_ENV };
    delete env.ALLOWED_SLACK_USER_IDS;
    expect(issuesOf(env).some((i) => i.startsWith('ALLOWED_SLACK_USER_IDS'))).toBe(true);
    expect(issuesOf({ ...env, ALLOWED_SLACK_USER_IDS: '  ' }).some((i) => i.startsWith('ALLOWED_SLACK_USER_IDS'))).toBe(
      true,
    );
    expect(issuesOf({ ...env, ALLOWED_SLACK_USER_IDS: ' , ,' }).some((i) => i.startsWith('ALLOWED_SLACK_USER_IDS'))).toBe(
      true,
    );
  });

  it('A07: parses a comma-separated list and rejects malformed IDs', () => {
    expect(parseConfig({ ...BASE_ENV, ALLOWED_SLACK_USER_IDS: 'U0AAA, W0BBB ,' }).ALLOWED_SLACK_USER_IDS).toEqual([
      'U0AAA',
      'W0BBB',
    ]);
    expect(issuesOf({ ...BASE_ENV, ALLOWED_SLACK_USER_IDS: 'alice' }).length).toBeGreaterThan(0);
    expect(issuesOf({ ...BASE_ENV, ALLOWED_SLACK_USER_IDS: '*' }).length).toBeGreaterThan(0);
  });

  it('requires both Slack tokens with the right prefixes', () => {
    expect(issuesOf({ ...BASE_ENV, SLACK_BOT_TOKEN: undefined }).some((i) => i.startsWith('SLACK_BOT_TOKEN'))).toBe(true);
    expect(issuesOf({ ...BASE_ENV, SLACK_APP_TOKEN: 'xoxb-wrong' }).some((i) => i.startsWith('SLACK_APP_TOKEN'))).toBe(
      true,
    );
  });

  it('requires at least one LLM provider, treating blank values as unset', () => {
    const issues = issuesOf({ ...BASE_ENV, ANTHROPIC_API_KEY: '   ' });
    expect(issues.some((i) => i.includes('no LLM provider'))).toBe(true);
  });

  it('reports a missing provider together with other errors in one pass', () => {
    const issues = issuesOf({ SLACK_APP_TOKEN: 'xapp-x', ALLOWED_SLACK_USER_IDS: 'U0AAA' });
    expect(issues.some((i) => i.startsWith('SLACK_BOT_TOKEN'))).toBe(true);
    expect(issues.some((i) => i.includes('no LLM provider'))).toBe(true);
  });

  it('rejects a DEFAULT_MODEL whose provider is unknown or has no key', () => {
    expect(issuesOf({ ...BASE_ENV, DEFAULT_MODEL: 'openai:gpt-5' }).some((i) => i.startsWith('DEFAULT_MODEL'))).toBe(true);
    expect(issuesOf({ ...BASE_ENV, DEFAULT_MODEL: 'acme:model' }).some((i) => i.startsWith('DEFAULT_MODEL'))).toBe(true);
    expect(issuesOf({ ...BASE_ENV, DEFAULT_MODEL: 'no-colon' }).some((i) => i.startsWith('DEFAULT_MODEL'))).toBe(true);
    expect(parseConfig({ ...BASE_ENV, OPENAI_API_KEY: 'k', DEFAULT_MODEL: 'openai:gpt-5' }).DEFAULT_MODEL).toBe(
      'openai:gpt-5',
    );
  });

  it('custom provider is enabled by CUSTOM_BASE_URL (must be a URL)', () => {
    const env = { SLACK_BOT_TOKEN: 'xoxb-a', SLACK_APP_TOKEN: 'xapp-a', ALLOWED_SLACK_USER_IDS: 'U0AAA' };
    expect(configuredProviders(parseConfig({ ...env, CUSTOM_BASE_URL: 'http://localhost:11434/v1', DEFAULT_MODEL: 'custom:llama3' }))).toEqual(['custom']);
    expect(issuesOf({ ...env, CUSTOM_BASE_URL: 'not a url' }).some((i) => i.startsWith('CUSTOM_BASE_URL'))).toBe(true);
  });

  it('A18: TZ must be a valid IANA zone', () => {
    expect(parseConfig({ ...BASE_ENV, TZ: 'America/New_York' }).TZ).toBe('America/New_York');
    expect(issuesOf({ ...BASE_ENV, TZ: 'Mars/Olympus' }).some((i) => i.startsWith('TZ'))).toBe(true);
  });

  it('A08: BASH_APPROVAL_MODE only accepts always|allowlist', () => {
    expect(parseConfig({ ...BASE_ENV, BASH_APPROVAL_MODE: 'allowlist' }).BASH_APPROVAL_MODE).toBe('allowlist');
    expect(issuesOf({ ...BASE_ENV, BASH_APPROVAL_MODE: 'never' }).some((i) => i.startsWith('BASH_APPROVAL_MODE'))).toBe(
      true,
    );
  });

  it('A06: HISTORY_MAX_MESSAGES is coerced and bounded', () => {
    expect(parseConfig({ ...BASE_ENV, HISTORY_MAX_MESSAGES: '50' }).HISTORY_MAX_MESSAGES).toBe(50);
    expect(issuesOf({ ...BASE_ENV, HISTORY_MAX_MESSAGES: '2' }).length).toBeGreaterThan(0);
    expect(issuesOf({ ...BASE_ENV, HISTORY_MAX_MESSAGES: 'lots' }).length).toBeGreaterThan(0);
  });

  it('never echoes secret values in ConfigError messages', () => {
    const secret = 'xoxp-SUPERSECRET-1234567890';
    try {
      parseConfig({ ...BASE_ENV, SLACK_BOT_TOKEN: secret, SLACK_APP_TOKEN: 'sk-ALSOSECRET' });
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const msg = (e as Error).message;
      expect(msg).not.toContain('SUPERSECRET');
      expect(msg).not.toContain('ALSOSECRET');
    }
  });
});

describe('getConfig / resetConfigCache', () => {
  it('caches until reset, then re-reads process.env', () => {
    applyEnv({ BASH_APPROVAL_MODE: 'always' });
    expect(getConfig().BASH_APPROVAL_MODE).toBe('always');
    process.env.BASH_APPROVAL_MODE = 'allowlist';
    expect(getConfig().BASH_APPROVAL_MODE).toBe('always');
    resetConfigCache();
    expect(getConfig().BASH_APPROVAL_MODE).toBe('allowlist');
  });
});

describe('dataPaths', () => {
  it('lays out every path under DATA_DIR', () => {
    const root = path.resolve('some-data-dir');
    const p = dataPaths(root);
    expect(p.root).toBe(root);
    expect(p.db).toBe(path.join(root, 'agent.db'));
    expect(p.memory).toBe(path.join(root, 'MEMORY.md'));
    expect(p.skills).toBe(path.join(root, 'skills'));
    expect(p.workspace).toBe(path.join(root, 'workspace'));
    expect(p.browserProfile).toBe(path.join(root, 'browser-profile'));
  });

  it('reads DATA_DIR from env at call time', () => {
    applyEnv({ DATA_DIR: path.resolve('elsewhere') });
    expect(dataPaths().root).toBe(path.resolve('elsewhere'));
  });
});
