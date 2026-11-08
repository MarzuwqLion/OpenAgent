/**
 * Zod-validated .env loader.
 *
 * Importing this module has no side effects and never throws. Call
 * `getConfig()` (cached) at boot; tests call `parseConfig(env)` directly or
 * set `process.env` and then `resetConfigCache()`.
 *
 * `.env` is loaded once, lazily, without overriding variables that are
 * already set. Set `DOTENV_DISABLE=1` to skip it (vitest does this).
 */
import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

/** Provider prefixes accepted in `provider:model` IDs. */
export const PROVIDERS = ['anthropic', 'openai', 'google', 'openrouter', 'custom'] as const;
export type ProviderName = (typeof PROVIDERS)[number];

/** Env var holding each provider's credential. `custom` is enabled by CUSTOM_BASE_URL instead. */
export const PROVIDER_KEY_ENV = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  custom: 'CUSTOM_BASE_URL',
} as const satisfies Record<ProviderName, string>;

export const DEFAULT_MODEL_FALLBACK = 'anthropic:claude-sonnet-5-5';

/** Blank strings in .env (`KEY=`) count as unset. */
const blankToUndefined = (v: unknown) =>
  typeof v === 'string' ? (v.trim() === '' ? undefined : v.trim()) : v;

const optionalString = z.preprocess(blankToUndefined, z.string().optional());

const SLACK_USER_ID = /^[UW][A-Z0-9]{2,}$/;

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const schema = z
  .object({
    SLACK_BOT_TOKEN: z.preprocess(
      blankToUndefined,
      z.string({ error: 'is required' }).startsWith('xoxb-', 'must be a bot token starting with xoxb-'),
    ),
    SLACK_APP_TOKEN: z.preprocess(
      blankToUndefined,
      z.string({ error: 'is required' }).startsWith('xapp-', 'must be an app-level token starting with xapp-'),
    ),
    SLACK_DEFAULT_CHANNEL: optionalString,

    // A07
    ALLOWED_SLACK_USER_IDS: z.preprocess(
      blankToUndefined,
      z
        .string({ error: 'is required (comma-separated Slack member IDs, e.g. U012ABCDEF)' })
        .transform((s) =>
          s
            .split(',')
            .map((id) => id.trim())
            .filter((id) => id.length > 0),
        )
        .pipe(
          z
            .array(z.string().regex(SLACK_USER_ID, 'each entry must be a Slack member ID like U012ABCDEF'))
            .min(1, 'must list at least one Slack member ID'),
        ),
    ),

    DEFAULT_MODEL: z.preprocess(
      blankToUndefined,
      z
        .string()
        .regex(/^[a-z0-9-]+:.+$/, 'must look like provider:model, e.g. anthropic:claude-sonnet-5-5')
        .default(DEFAULT_MODEL_FALLBACK),
    ),
    ANTHROPIC_API_KEY: optionalString,
    OPENAI_API_KEY: optionalString,
    GOOGLE_GENERATIVE_AI_API_KEY: optionalString,
    OPENROUTER_API_KEY: optionalString,
    CUSTOM_BASE_URL: z.preprocess(blankToUndefined, z.url('must be a URL').optional()),
    CUSTOM_API_KEY: optionalString,

    // A18
    TZ: z.preprocess(
      blankToUndefined,
      z.string().refine(isValidTimeZone, 'must be an IANA time zone, e.g. America/New_York').default('UTC'),
    ),
    // A08
    BASH_APPROVAL_MODE: z.preprocess(blankToUndefined, z.enum(['always', 'allowlist']).default('always')),
    // A06
    HISTORY_MAX_MESSAGES: z.preprocess(
      blankToUndefined,
      z.coerce.number().int().min(10).max(10_000).default(120),
    ),
    DATA_DIR: z.preprocess(
      blankToUndefined,
      z
        .string()
        .default('./data')
        .transform((p) => path.resolve(p)),
    ),
  })
  .superRefine((cfg, ctx) => {
    const configured = configuredProviders(cfg);
    if (configured.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['ANTHROPIC_API_KEY'],
        message:
          'no LLM provider configured: set at least one of ANTHROPIC_API_KEY, OPENAI_API_KEY, ' +
          'GOOGLE_GENERATIVE_AI_API_KEY, OPENROUTER_API_KEY or CUSTOM_BASE_URL',
      });
      return;
    }
    const provider = cfg.DEFAULT_MODEL.slice(0, cfg.DEFAULT_MODEL.indexOf(':'));
    if (!(PROVIDERS as readonly string[]).includes(provider)) {
      ctx.addIssue({
        code: 'custom',
        path: ['DEFAULT_MODEL'],
        message: `unknown provider "${provider}" (expected one of ${PROVIDERS.join(', ')})`,
      });
    } else if (!configured.includes(provider as ProviderName)) {
      ctx.addIssue({
        code: 'custom',
        path: ['DEFAULT_MODEL'],
        message: `provider "${provider}" has no credentials: set ${PROVIDER_KEY_ENV[provider as ProviderName]}`,
      });
    }
  });

export type Config = z.output<typeof schema>;

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid configuration (.env):\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

/** Providers whose credentials are present, in PROVIDERS order. */
export function configuredProviders(
  cfg: Pick<
    Config,
    'ANTHROPIC_API_KEY' | 'OPENAI_API_KEY' | 'GOOGLE_GENERATIVE_AI_API_KEY' | 'OPENROUTER_API_KEY' | 'CUSTOM_BASE_URL'
  >,
): ProviderName[] {
  return PROVIDERS.filter((p) => Boolean(cfg[PROVIDER_KEY_ENV[p]]));
}

/** Pure: validate an env object. Throws ConfigError listing every problem. */
export function parseConfig(env: Record<string, string | undefined>): Config {
  const result = schema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const key = issue.path.join('.') || '(env)';
      return `${key}: ${issue.message}`;
    });
    // zod skips superRefine when base fields fail; still report a missing
    // provider now so the user can fix everything in one pass.
    const anyProvider = PROVIDERS.some((p) => blankToUndefined(env[PROVIDER_KEY_ENV[p]]) !== undefined);
    if (!anyProvider && !issues.some((i) => i.includes('no LLM provider'))) {
      issues.push(
        'ANTHROPIC_API_KEY: no LLM provider configured: set at least one of ANTHROPIC_API_KEY, OPENAI_API_KEY, ' +
          'GOOGLE_GENERATIVE_AI_API_KEY, OPENROUTER_API_KEY or CUSTOM_BASE_URL',
      );
    }
    throw new ConfigError(issues);
  }
  return result.data;
}

let dotenvLoaded = false;
function ensureDotenv(): void {
  if (dotenvLoaded) return;
  dotenvLoaded = true;
  if (process.env.DOTENV_DISABLE === '1') return;
  dotenv.config({ quiet: true, override: false });
}

let cached: Config | undefined;

/** Load `.env` (once) and return the validated config. Throws ConfigError. */
export function getConfig(): Config {
  if (cached) return cached;
  ensureDotenv();
  cached = parseConfig(process.env);
  return cached;
}

/** Tests: forget the cached config so the next getConfig() re-reads process.env. */
export function resetConfigCache(): void {
  cached = undefined;
}

export interface DataPaths {
  root: string;
  db: string;
  memory: string;
  skills: string;
  workspace: string;
  browserProfile: string;
}

/**
 * Filesystem layout under DATA_DIR. Does not validate the rest of the config,
 * so it is safe to call from tools, tests and the doctor.
 */
export function dataPaths(dataDir?: string): DataPaths {
  ensureDotenv();
  const root = path.resolve(dataDir ?? (blankToUndefined(process.env.DATA_DIR) as string | undefined) ?? './data');
  return {
    root,
    db: path.join(root, 'agent.db'),
    memory: path.join(root, 'MEMORY.md'),
    skills: path.join(root, 'skills'),
    workspace: path.join(root, 'workspace'),
    browserProfile: path.join(root, 'browser-profile'),
  };
}
