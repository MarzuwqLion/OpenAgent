/**
 * Live, budgeted probes against the real providers in .env. OFF by default:
 * run with `LIVE_LLM=1 npx vitest run test/live.providers.test.ts`.
 *
 * Budget (enforced by LIVE_BUDGET): <= 25 real calls total, maxOutputTokens 200,
 * cheapest model per provider, no retries beyond the SDK default. vitest sets
 * DOTENV_DISABLE=1, so .env is loaded explicitly here and NOWHERE else.
 *
 * Secrets are never printed: only model IDs and pass/fail are asserted/logged.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import dotenv from 'dotenv';
import { generateText } from 'ai';

const LIVE = process.env.LIVE_LLM === '1';
const LIVE_BUDGET = 25;
let calls = 0;

// Cheapest widely-available model per provider (from listAvailableModels suggestions).
const CHEAP: Record<string, string> = {
  anthropic: 'anthropic:claude-haiku-4-5',
  openai: 'openai:gpt-5.4-nano',
  google: 'google:gemini-2.5-flash',
  deepseek: 'deepseek:deepseek-v4-flash',
  xai: 'xai:grok-4.5',
};

let resolveModel: (t?: string, s?: string) => { modelId: string; model: unknown };
let configured: string[] = [];

beforeAll(async () => {
  if (!LIVE) return;
  // Load the real .env explicitly (only here).
  dotenv.config({ path: path.resolve(process.cwd(), '.env'), quiet: true, override: false });
  const llm = await import('../src/llm.js');
  const cfg = await import('../src/config.js');
  const db = await import('../src/db.js');
  db.initDb(':memory:'); // resolveModel reads settings.default_model
  resolveModel = llm.resolveModel;
  configured = (cfg.configuredProviders(cfg.getConfig()) as string[]).filter((p) => p in CHEAP);
});

function budgeted(): boolean {
  if (calls >= LIVE_BUDGET) return false;
  calls += 1;
  return true;
}

describe.skipIf(!LIVE)('live providers: cheapest model answers (catches stale IDs)', () => {
  for (const provider of Object.keys(CHEAP)) {
    it(`${provider}: ${CHEAP[provider]} responds`, async () => {
      if (!configured.includes(provider)) {
        // Provider not configured in this .env: nothing to probe.
        return;
      }
      if (!budgeted()) throw new Error('LIVE budget exhausted');
      const { model, modelId } = resolveModel(undefined, CHEAP[provider]);
      const res = await generateText({
        model: model as never,
        maxOutputTokens: 200,
        prompt: 'Reply with exactly: OK',
      });
      expect(modelId).toBe(CHEAP[provider]);
      expect(res.text.length).toBeGreaterThan(0);
    });
  }
});

afterAll(() => {
  if (LIVE) {
    // Record count only; never any key or response content beyond length.
    fs.writeFileSync(
      path.resolve(process.cwd(), 'test/.live-call-count'),
      `live LLM calls this run: ${calls}\n`,
    );
  }
});
