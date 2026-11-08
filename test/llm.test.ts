import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetConfigCache } from '../src/config.js';
import { ensureThread, setGlobalModel, setThreadModel } from '../src/db.js';
import { applyEnv, setupTestEnv, type TestEnv } from './helpers/env.js';
import { loadSrc, type LlmModule } from './helpers/modules.js';

const LLM_ENV = {
  DEFAULT_MODEL: 'anthropic:claude-env-default',
  OPENAI_API_KEY: 'test-openai',
  OPENROUTER_API_KEY: 'test-openrouter',
  // GOOGLE_GENERATIVE_AI_API_KEY and CUSTOM_BASE_URL deliberately unset
};

// Some implementations read config at import time; make it valid before loading.
applyEnv(LLM_ENV);
const llm = await loadSrc<LlmModule>('llm.js');

let env: TestEnv;
beforeEach(async () => {
  env = await setupTestEnv({ env: LLM_ENV });
});
afterEach(async () => {
  await env.cleanup();
});

describe.skipIf(!llm)('resolveModel precedence (all 4 levels)', () => {
  const resolve = async (threadTs?: string, skillModel?: string) => (await llm!.resolveModel(threadTs, skillModel)).modelId;

  it('level 4: falls back to env.DEFAULT_MODEL when nothing else is set', async () => {
    expect(await resolve()).toBe('anthropic:claude-env-default');
    expect(await resolve('unknown-thread')).toBe('anthropic:claude-env-default');
  });

  it('level 3: settings.default_model beats env', async () => {
    setGlobalModel('openai:gpt-global');
    expect(await resolve()).toBe('openai:gpt-global');
  });

  it('level 2: the skill model beats the global and env models; empty skill model is ignored', async () => {
    setGlobalModel('openai:gpt-global');
    expect(await resolve(undefined, 'openai:gpt-skill')).toBe('openai:gpt-skill');
    expect(await resolve(undefined, '')).toBe('openai:gpt-global');
  });

  it('level 1: threads.model_override beats everything', async () => {
    setGlobalModel('openai:gpt-global');
    ensureThread({ threadTs: 't-override', channelId: 'C1' });
    setThreadModel('t-override', 'anthropic:claude-thread');
    expect(await resolve('t-override', 'openai:gpt-skill')).toBe('anthropic:claude-thread');
    // a thread without an override falls through to the skill model
    ensureThread({ threadTs: 't-plain', channelId: 'C1' });
    expect(await resolve('t-plain', 'openai:gpt-skill')).toBe('openai:gpt-skill');
  });

  it('returns a model object, not just an id', async () => {
    const r = await llm!.resolveModel();
    expect(r.model).toBeTruthy();
  });

  it('(reviewer, beyond pinned API) does not resolve a stored global model whose provider lost its key', async () => {
    // A stale override (e.g. google:...) whose key was removed from .env must not
    // produce a model bound to a keyless provider; it should fall through or throw.
    setGlobalModel('google:gemini-2.5-pro');
    let id: string | undefined;
    try {
      id = await resolve();
    } catch {
      id = undefined;
    }
    expect(id).not.toBe('google:gemini-2.5-pro');
  });
});

describe.skipIf(!llm)('validateModelId', () => {
  const ok = (id: string) => llm!.validateModelId(id).ok;

  it('accepts configured providers', () => {
    expect(ok('anthropic:claude-sonnet-4-5')).toBe(true);
    expect(ok('openai:gpt-5')).toBe(true);
  });

  it('accepts openrouter ids containing slashes and colons', () => {
    expect(ok('openrouter:vendor/model:free')).toBe(true);
  });

  it('rejects malformed ids', () => {
    for (const bad of ['no-colon', 'anthropic:', ':claude', '', '   ', 'anthropic: ']) {
      const r = llm!.validateModelId(bad);
      expect(r.ok, `"${bad}" should be rejected`).toBe(false);
      if (!r.ok) expect(r.reason.length).toBeGreaterThan(0);
    }
  });

  it('rejects unknown providers', () => {
    expect(ok('acme:model-1')).toBe(false);
    expect(ok('__proto__:x')).toBe(false);
    expect(ok('constructor:x')).toBe(false);
  });

  it('rejects keyless providers', () => {
    expect(ok('google:gemini-2.5-pro')).toBe(false);
    expect(ok('custom:llama3')).toBe(false);
  });

  it('custom:<model> is accepted only when CUSTOM_BASE_URL is set (read at call time)', () => {
    process.env.CUSTOM_BASE_URL = 'http://localhost:11434/v1';
    resetConfigCache();
    expect(ok('custom:llama3')).toBe(true);
  });
});

describe.skipIf(!llm)('listAvailableModels', () => {
  it('lists only provider:model ids for configured providers', () => {
    const models = llm!.listAvailableModels();
    expect(models.length).toBeGreaterThan(0);
    for (const m of models) {
      expect(m).toMatch(/^[a-z0-9-]+:.+$/);
      const provider = m.slice(0, m.indexOf(':'));
      expect(['anthropic', 'openai', 'openrouter']).toContain(provider);
    }
  });

  it('never lists a keyless provider', () => {
    applyEnv({ ...LLM_ENV, OPENAI_API_KEY: undefined, OPENROUTER_API_KEY: undefined, DATA_DIR: env.dataDir });
    const models = llm!.listAvailableModels();
    expect(models.every((m) => m.startsWith('anthropic:'))).toBe(true);
  });
});

if (!(llm)) describe('llm.ts not written yet', () => {
  it.todo('resolveModel / validateModelId / listAvailableModels');
});
