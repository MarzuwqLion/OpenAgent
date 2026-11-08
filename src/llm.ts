/**
 * Multi-provider model registry and the model resolver.
 *
 * Config is read at call time (never at module load) so tests can swap
 * process.env + resetConfigCache() between cases. The registry is rebuilt
 * whenever getConfig() returns a new object.
 */
import { createAnthropic } from '@ai-sdk/anthropic';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createXai } from '@ai-sdk/xai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { createProviderRegistry, type LanguageModel } from 'ai';
import { configuredProviders, getConfig, PROVIDERS, PROVIDER_KEY_ENV, type Config, type ProviderName } from './config.js';
import { getGlobalModel, getThread } from './db.js';

type RegistryProviders = Parameters<typeof createProviderRegistry>[0];
type Registry = ReturnType<typeof createProviderRegistry<RegistryProviders>>;

/**
 * Suggested model IDs per provider, taken from the model-ID unions of the
 * installed provider packages (@ai-sdk/anthropic 4.0.99, @ai-sdk/openai
 * 4.0.111, @ai-sdk/google 4.0.114, @ai-sdk/deepseek 3.0.81, @ai-sdk/xai
 * 5.0.40; xAI image/video/voice models skipped). Any other model string the provider
 * accepts also works; these are only what the agent advertises.
 */
const SUGGESTED_MODELS: Record<Exclude<ProviderName, 'custom'>, string[]> = {
  anthropic: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-sonnet-4-5', 'claude-haiku-4-5'],
  openai: ['gpt-5.5', 'gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5'],
  // REVIEW-H2: gemini-2.5-pro/-flash were retired for new users (404); these three were live-verified in Wave 3.
  google: ['gemini-pro-latest', 'gemini-flash-latest', 'gemini-3.1-pro-preview'],
  // OpenRouter accepts any `vendor/model` slug (its type is plain string).
  openrouter: ['anthropic/claude-sonnet-5-5', 'openai/gpt-5.5', 'google/gemini-2.5-pro'],
  deepseek: ['deepseek-v4-pro', 'deepseek-v4-flash'],
  xai: ['grok-4.7', 'grok-4.6', 'grok-4.5', 'grok-latest', 'grok-4.20-reasoning', 'grok-4.20-non-reasoning'],
};

let cachedFor: Config | undefined;
let cachedRegistry: Registry | undefined;

/** Registry containing only providers whose credentials are configured. */
export function getRegistry(): Registry {
  const cfg = getConfig();
  if (cachedRegistry && cachedFor === cfg) return cachedRegistry;

  const providers: RegistryProviders = {};
  if (cfg.ANTHROPIC_API_KEY) providers.anthropic = createAnthropic({ apiKey: cfg.ANTHROPIC_API_KEY });
  if (cfg.OPENAI_API_KEY) providers.openai = createOpenAI({ apiKey: cfg.OPENAI_API_KEY });
  if (cfg.GOOGLE_GENERATIVE_AI_API_KEY) {
    providers.google = createGoogleGenerativeAI({ apiKey: cfg.GOOGLE_GENERATIVE_AI_API_KEY });
  }
  if (cfg.OPENROUTER_API_KEY) {
    providers.openrouter = createOpenRouter({ apiKey: cfg.OPENROUTER_API_KEY, compatibility: 'strict' });
  }
  // apiKey passed explicitly: XAI_API_KEY may come from the GROK_API_KEY alias (config.ts).
  if (cfg.DEEPSEEK_API_KEY) providers.deepseek = createDeepSeek({ apiKey: cfg.DEEPSEEK_API_KEY });
  if (cfg.XAI_API_KEY) providers.xai = createXai({ apiKey: cfg.XAI_API_KEY });
  if (cfg.CUSTOM_BASE_URL) {
    providers.custom = createOpenAICompatible({
      name: 'custom',
      baseURL: cfg.CUSTOM_BASE_URL,
      ...(cfg.CUSTOM_API_KEY ? { apiKey: cfg.CUSTOM_API_KEY } : {}),
    });
  }

  // The registry splits on the FIRST separator only, so
  // `openrouter:vendor/model:free` resolves to provider `openrouter`,
  // model `vendor/model:free`.
  cachedRegistry = createProviderRegistry(providers, { separator: ':' });
  cachedFor = cfg;
  return cachedRegistry;
}

/** Split `provider:model` on the first colon. */
export function parseModelId(id: string): { provider: string; model: string } | undefined {
  const idx = id.indexOf(':');
  if (idx === -1) return undefined;
  return { provider: id.slice(0, idx), model: id.slice(idx + 1) };
}

export type ModelIdValidation = { ok: true } | { ok: false; reason: string };

/**
 * Reject malformed IDs, unknown providers and providers without credentials.
 * Does not contact the provider, so an unknown model name on a configured
 * provider passes and fails later at call time.
 */
export function validateModelId(id: string): ModelIdValidation {
  if (typeof id !== 'string' || id.trim() === '') return { ok: false, reason: 'model id is empty' };
  if (/\s/.test(id)) return { ok: false, reason: `"${id}" contains whitespace` };
  const parsed = parseModelId(id);
  if (!parsed) {
    return { ok: false, reason: `"${id}" must look like provider:model, e.g. anthropic:claude-sonnet-5-5` };
  }
  const { provider, model } = parsed;
  if (provider === '') return { ok: false, reason: `"${id}" has an empty provider` };
  if (model === '') return { ok: false, reason: `"${id}" has an empty model name` };
  if (!(PROVIDERS as readonly string[]).includes(provider)) {
    return { ok: false, reason: `unknown provider "${provider}" (expected one of ${PROVIDERS.join(', ')})` };
  }
  const configured = configuredProviders(getConfig());
  if (!configured.includes(provider as ProviderName)) {
    return {
      ok: false,
      reason: `provider "${provider}" is not configured: set ${PROVIDER_KEY_ENV[provider as ProviderName]}${
        provider === 'xai' ? ' (or GROK_API_KEY)' : ''
      } in .env`,
    };
  }
  return { ok: true };
}

/**
 * Model IDs the agent can switch to: suggestions for every configured
 * provider, plus the env default and the global `/model` setting.
 * Never lists a provider without credentials.
 */
export function listAvailableModels(): string[] {
  const cfg = getConfig();
  const out = new Set<string>();
  const push = (id: string | null | undefined) => {
    if (id && validateModelId(id).ok) out.add(id);
  };
  push(cfg.DEFAULT_MODEL);
  try {
    push(getGlobalModel());
  } catch {
    // DB not initialized (e.g. doctor or unit tests): suggestions only.
  }
  for (const provider of configuredProviders(cfg)) {
    if (provider === 'custom') continue; // model names are endpoint-specific; only explicit IDs above
    for (const model of SUGGESTED_MODELS[provider]) push(`${provider}:${model}`);
  }
  return [...out];
}

/**
 * Pick the model for a turn. Precedence (highest first):
 *   1. threads.model_override
 *   2. the skill's frontmatter `model` (non-empty)
 *   3. settings.default_model (`/model`)
 *   4. env DEFAULT_MODEL
 * A level whose ID is no longer valid (e.g. its provider key was removed
 * from .env) is skipped with a warning rather than failing the turn.
 */
export function resolveModel(threadTs?: string, skillModel?: string): { modelId: string; model: LanguageModel } {
  const candidates: Array<{ source: string; id: string | null | undefined }> = [
    { source: 'thread override', id: threadTs ? getThread(threadTs)?.modelOverride : undefined },
    { source: 'skill frontmatter', id: skillModel?.trim() },
    { source: 'global /model setting', id: getGlobalModel() },
  ];
  let modelId = getConfig().DEFAULT_MODEL;
  for (const c of candidates) {
    if (!c.id) continue;
    const v = validateModelId(c.id);
    if (v.ok) {
      modelId = c.id;
      break;
    }
    console.warn(`[llm] ignoring ${c.source} "${c.id}": ${v.reason}`);
  }
  const model = getRegistry().languageModel(modelId as `${string}:${string}`);
  return { modelId, model };
}
