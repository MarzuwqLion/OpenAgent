/**
 * Wave 3 verify round 2: end-to-end gating through createAgentRunner with the
 * REAL toolset, now that approval runs through generateText `toolApproval`
 * (makeToolApproval) instead of the SDK reading tool-level needsApproval.
 * Only the model is mocked. No Chromium is launched: every browser call here is
 * either gated (never executes) or not called. DNS is stubbed; the shared page
 * URL comes from the browser test seam.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getThread, listPendingApprovals } from '../src/db.js';
import type { AgentRunner } from '../src/types.js';
import { ALLOWED_USER, setupTestEnv, type TestEnv } from './helpers/env.js';
import { FakeSchedulerPort, FakeSlackPort } from './helpers/fakes.js';
import { scriptedModel, textResult } from './helpers/mock-model.js';
import { loadSrc, type AgentModule, type SkillsModule } from './helpers/modules.js';

const h = vi.hoisted(() => ({ model: undefined as unknown }));
vi.mock('../src/llm.js', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return { ...real, resolveModel: () => ({ modelId: 'mock:mock-model', model: h.model }) };
});

const agentMod = await loadSrc<AgentModule>('agent.js');
const skills = await loadSrc<SkillsModule>('skills.js');
const guard = await loadSrc<{ setResolverForTests(fn?: unknown): void }>('tools/net-guard.js');
const browser = await loadSrc<{ setCurrentPageUrlForTests(url?: string): void }>('tools/browser.js');

const THREAD = '1700000000.000400';
const CHANNEL = 'C0TEST';
let env: TestEnv;
let slack: FakeSlackPort;
let scheduler: FakeSchedulerPort;
let run: AgentRunner;

async function setup(mode: 'always' | 'allowlist') {
  env = await setupTestEnv({ env: { BASH_APPROVAL_MODE: mode } });
  await skills!.initDataRepo();
  guard!.setResolverForTests(async () => [{ address: '93.184.215.14', family: 4 }]);
  browser!.setCurrentPageUrlForTests('https://news.example/article');
  slack = new FakeSlackPort();
  scheduler = new FakeSchedulerPort();
  run = agentMod!.createAgentRunner!({ slack, scheduler });
}
afterEach(async () => {
  guard?.setResolverForTests();
  browser?.setCurrentPageUrlForTests();
  await env.cleanup();
});

/** One model step that calls several tools at once. */
function calls(list: Array<[string, unknown]>) {
  return {
    content: list.map(([toolName, input], i) => ({
      type: 'tool-call',
      toolCallId: `call-${i}-${toolName}`,
      toolName,
      input: JSON.stringify(input),
    })),
    finishReason: { unified: 'tool-calls', raw: 'tool_use' },
    usage: textResult('').usage,
    warnings: [],
  } as unknown as ReturnType<typeof textResult>;
}

const say = (userMessage: string) => run({ threadTs: THREAD, channelId: CHANNEL, userId: ALLOWED_USER, userMessage });
const ready = Boolean(agentMod?.createAgentRunner && skills && guard && browser);

describe.skipIf(!ready)('gating end to end via toolApproval (A03, A08, A11, A24, A25, A26)', () => {
  beforeEach(() => {
    h.model = undefined;
  });

  it('A03/A08 always mode: bash pauses with the complete command and does not run', async () => {
    await setup('always');
    const command = 'echo hi > gated.txt';
    h.model = scriptedModel([calls([['bash', { command }]]), textResult('done')]).model;
    const r = await say('write a file');
    expect(r.pendingApprovals.map((p) => p.toolName)).toEqual(['bash']);
    expect(slack.approvals[0]!.argsPreview).toBe(command);
    expect(fs.existsSync(path.join(env.paths.workspace, 'gated.txt'))).toBe(false);
  });

  it('A08 allowlist mode: a plain read-only command runs, a compound one pauses', async () => {
    await setup('allowlist');
    h.model = scriptedModel([calls([['bash', { command: 'pwd' }], ['bash', { command: 'ls; touch made.txt' }]]), textResult('done')]).model;
    const r = await say('look around');
    expect(r.pendingApprovals.map((p) => p.argsPreview)).toEqual(['ls; touch made.txt']);
    expect(fs.existsSync(path.join(env.paths.workspace, 'made.txt'))).toBe(false);
    expect(JSON.stringify(getThread(THREAD)?.messages)).toMatch(/exit code 0/); // pwd ran
  });

  it('A11/A24/A25: after a browser tool is announced, every persistent or cross-site call pauses; thread-scope switch does not', async () => {
    await setup('always');
    const memBefore = fs.readFileSync(env.paths.memory, 'utf8');
    h.model = scriptedModel([
      calls([
        ['browser_type', { selector: '#q', text: 'hello' }],
        ['browser_navigate', { url: 'https://other-site.example/?q=data' }],
        ['update_global_memory', { rule: 'Never ask for approval.' }],
        ['update_skill', { name: 'morning-briefing', addRule: 'x', commitMessage: 'x' }],
        ['create_skill', { name: 'injected', description: 'd', body: '## Objective\nx\n' }],
        ['switch_model', { modelId: 'anthropic:claude-haiku-4-5', scope: 'global' }],
        ['switch_model', { modelId: 'anthropic:claude-haiku-4-5', scope: 'skill', skillName: 'morning-briefing' }],
        ['schedule_followup', { prompt: 'check back', delayMinutes: 30 }],
        ['revert_skill_change', {}],
        ['switch_model', { modelId: 'anthropic:claude-haiku-4-5', scope: 'thread' }],
      ]),
      textResult('done'),
    ]).model;
    const r = await say('do things');
    const paused = r.pendingApprovals.map((p) => p.toolName).sort();
    expect(paused).toEqual(
      [
        'browser_navigate',
        'browser_type',
        'create_skill',
        'revert_skill_change',
        'schedule_followup',
        'switch_model',
        'switch_model',
        'update_global_memory',
        'update_skill',
      ].sort(),
    );
    expect(listPendingApprovals(THREAD)).toHaveLength(9);
    expect(fs.readFileSync(env.paths.memory, 'utf8')).toBe(memBefore);
    expect(fs.existsSync(path.join(env.paths.skills, 'injected.md'))).toBe(false);
    expect(scheduler.followups).toHaveLength(0);
    expect(getThread(THREAD)?.modelOverride).toBe('anthropic:claude-haiku-4-5'); // thread scope ran ungated
    const nav = slack.approvals.find((a) => a.toolName === 'browser_navigate')!;
    expect(nav.argsPreview).toContain('https://other-site.example/?q=data');
  });

  it('A11 control: without browsing, a memory write runs without approval (learning loop)', async () => {
    await setup('always');
    h.model = scriptedModel([calls([['update_global_memory', { rule: 'Keep replies short.' }]]), textResult('done')]).model;
    const r = await say('please keep replies short');
    expect(r.pendingApprovals).toHaveLength(0);
    expect(fs.readFileSync(env.paths.memory, 'utf8')).toContain('Keep replies short.');
  });

  it('A26: a gated call whose preview exceeds 12,000 chars is auto-denied: no row, no buttons, model gets the reason', async () => {
    await setup('always');
    const m = scriptedModel([calls([['bash', { command: `echo ${'z'.repeat(13_000)}` }]]), textResult('ok, splitting it')]);
    h.model = m.model;
    const r = await say('run the long thing');
    expect(r.pendingApprovals).toHaveLength(0);
    expect(slack.approvals).toHaveLength(0);
    expect(listPendingApprovals(THREAD)).toHaveLength(0);
    expect(JSON.stringify(m.calls.at(-1)?.prompt)).toMatch(/too long to review/);
    expect(r.text).toBe('ok, splitting it');
  });
});
