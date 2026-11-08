/**
 * createAgentRunner (Wave 2) end to end with MockLanguageModelV4:
 * A03/A13 approval round-trip, A05 concurrent turns, A06 truncation on the wire.
 *
 * llm.resolveModel is mocked to return the scripted mock model, and
 * tools/index.createTools to return a recording `bash` (needsApproval: true)
 * plus a `big_output` tool, so nothing touches a real shell or provider.
 * Assumes agent.ts imports createTools from './tools/index.js' and
 * resolveModel from './llm.js' (A01/A02 layout).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelMessage } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import {
  getApproval,
  getApprovalByApprovalId,
  getThread,
  listPendingApprovals,
  resolveApproval,
} from '../src/db.js';
import { isThreadLocked } from '../src/locks.js';
import type { AgentRunner, ToolContext } from '../src/types.js';
import { ALLOWED_USER, applyEnv, setupTestEnv, type TestEnv } from './helpers/env.js';
import { FakeSchedulerPort, FakeSlackPort } from './helpers/fakes.js';
import { scriptedModel, textResult, toolCallResult, type ScriptedModel } from './helpers/mock-model.js';
import { loadSrc, type AgentModule, type SkillsModule } from './helpers/modules.js';

const h = vi.hoisted(() => ({
  model: undefined as unknown,
  execute: vi.fn(async (_input: { command: string }) => 'TOOL_OUTPUT_MARKER'),
  contexts: [] as unknown[],
}));

vi.mock('../src/llm.js', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return { ...real, resolveModel: () => ({ modelId: 'mock:mock-model', model: h.model }) };
});

vi.mock('../src/tools/index.js', async () => {
  const { tool } = await import('ai');
  const { z } = await import('zod');
  return {
    createTools: (ctx: unknown) => {
      h.contexts.push(ctx);
      return {
        bash: tool({
          description: 'Run a shell command',
          inputSchema: z.object({ command: z.string() }),
          needsApproval: true,
          execute: async (input: { command: string }) => h.execute(input),
        }),
        big_output: tool({
          description: 'Returns a huge string',
          inputSchema: z.object({}),
          execute: async () => `BIG_HEAD${'x'.repeat(60_000)}BIG_TAIL`,
        }),
      };
    },
  };
});

applyEnv();
const agentMod = await loadSrc<AgentModule>('agent.js');
const skills = await loadSrc<SkillsModule>('skills.js');
const ready = Boolean(agentMod?.createAgentRunner);

const THREAD = '1700000000.000100';
const CHANNEL = 'C0TEST';

let env: TestEnv;
let slack: FakeSlackPort;
let scheduler: FakeSchedulerPort;
let run: AgentRunner;

beforeEach(async () => {
  env = await setupTestEnv();
  if (skills) await skills.initDataRepo();
  h.execute.mockClear();
  h.contexts.length = 0;
  slack = new FakeSlackPort();
  scheduler = new FakeSchedulerPort();
  if (ready) run = agentMod!.createAgentRunner!({ slack, scheduler });
});
afterEach(async () => {
  await env.cleanup();
});

function useModel(m: ScriptedModel): ScriptedModel {
  h.model = m.model;
  return m;
}

const userTexts = (msgs: ModelMessage[]) =>
  msgs
    .filter((m) => m.role === 'user')
    .map((m) =>
      typeof m.content === 'string'
        ? m.content
        : m.content.map((p) => (p.type === 'text' ? p.text : '')).join(''),
    );

const systemText = (m: ScriptedModel, call = 0) =>
  JSON.stringify((m.calls[call]?.prompt ?? []).filter((p) => p.role === 'system'));

describe.skipIf(!ready)('approval round-trip (A03, A13)', () => {
  async function pauseOnBash(command = 'ls') {
    const m = useModel(scriptedModel([toolCallResult('call-1', 'bash', { command }), textResult('all done')]));
    const r1 = await run({ threadTs: THREAD, channelId: CHANNEL, userId: ALLOWED_USER, userMessage: 'list files' });
    return { m, r1 };
  }

  it('model calls bash → approval row created, buttons posted, nothing executed', async () => {
    const { r1 } = await pauseOnBash();
    expect(h.execute).not.toHaveBeenCalled();
    expect(r1.pendingApprovals).toHaveLength(1);
    const req = r1.pendingApprovals[0]!;
    expect(req.toolName).toBe('bash');
    expect(req.threadTs).toBe(THREAD);
    expect(req.channelId).toBe(CHANNEL);
    expect(req.argsPreview).toContain('ls');
    expect(slack.approvals).toHaveLength(1);
    expect(slack.approvals[0]).toMatchObject({ id: req.id, approvalId: req.approvalId });
    const row = getApproval(req.id);
    expect(row?.status).toBe('PENDING');
    expect(row?.approvalId).toBe(req.approvalId);
    expect(row?.toolArgs).toEqual({ command: 'ls' });
    // the paused state is persisted so a restart can resume it
    expect(JSON.stringify(getThread(THREAD)?.messages)).toContain('tool-approval-request');
  });

  it('argsPreview is truncated to ~500 chars', async () => {
    const { r1 } = await pauseOnBash(`echo ${'a'.repeat(2_000)}`);
    expect(r1.pendingApprovals[0]!.argsPreview.length).toBeLessThanOrEqual(503);
  });

  it('approve → the tool executes exactly once and its output reaches the model', async () => {
    const { m, r1 } = await pauseOnBash();
    const req = r1.pendingApprovals[0]!;
    expect(resolveApproval(req.id, true, ALLOWED_USER)).toBe(true);
    const r2 = await run({
      threadTs: THREAD,
      channelId: CHANNEL,
      userId: ALLOWED_USER,
      approvalResponse: { approvalId: req.approvalId, approved: true },
    });
    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(h.execute.mock.calls[0]![0]).toEqual({ command: 'ls' });
    expect(JSON.stringify(m.calls.at(-1)?.prompt)).toContain('TOOL_OUTPUT_MARKER');
    expect(r2.text).toBe('all done');
    expect(r2.pendingApprovals).toHaveLength(0);
    expect(JSON.stringify(getThread(THREAD)?.messages)).toContain('TOOL_OUTPUT_MARKER');
  });

  it('replaying the same approval does not execute the tool a second time', async () => {
    const { r1 } = await pauseOnBash();
    const req = r1.pendingApprovals[0]!;
    resolveApproval(req.id, true, ALLOWED_USER);
    const resume = { threadTs: THREAD, channelId: CHANNEL, userId: ALLOWED_USER, approvalResponse: { approvalId: req.approvalId, approved: true } };
    await run(resume);
    await run(resume).catch(() => undefined);
    expect(h.execute).toHaveBeenCalledTimes(1);
  });

  it('reject → not executed, the denial reaches the model, and it is not retried', async () => {
    const { m, r1 } = await pauseOnBash('rm -rf build');
    const req = r1.pendingApprovals[0]!;
    expect(resolveApproval(req.id, false, ALLOWED_USER)).toBe(true);
    const r2 = await run({
      threadTs: THREAD,
      channelId: CHANNEL,
      userId: ALLOWED_USER,
      approvalResponse: { approvalId: req.approvalId, approved: false, reason: 'no' },
    });
    expect(h.execute).not.toHaveBeenCalled();
    expect(JSON.stringify(m.calls.at(-1)?.prompt)).toMatch(/denied/i);
    expect(r2.pendingApprovals).toHaveLength(0);
    expect(slack.approvals).toHaveLength(1); // no second approval request
    expect(listPendingApprovals(THREAD)).toHaveLength(0);
  });

  it('the system prompt tells the model not to retry a denied tool call', async () => {
    const { m } = await pauseOnBash();
    expect(systemText(m)).toMatch(/do not retry/i);
  });

  it('a model that retries after a denial gets a fresh approval request, never a silent execution', async () => {
    const m = useModel(
      scriptedModel([
        toolCallResult('call-1', 'bash', { command: 'rm -rf build' }),
        toolCallResult('call-2', 'bash', { command: 'rm -rf build' }), // disobedient retry
        textResult('done'),
      ]),
    );
    const r1 = await run({ threadTs: THREAD, channelId: CHANNEL, userId: ALLOWED_USER, userMessage: 'clean' });
    const req = r1.pendingApprovals[0]!;
    resolveApproval(req.id, false, ALLOWED_USER);
    const r2 = await run({ threadTs: THREAD, channelId: CHANNEL, userId: ALLOWED_USER, approvalResponse: { approvalId: req.approvalId, approved: false } });
    expect(h.execute).not.toHaveBeenCalled();
    expect(r2.pendingApprovals).toHaveLength(1);
    expect(m.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('an approval response for another thread does not execute anything', async () => {
    const { r1 } = await pauseOnBash();
    const req = r1.pendingApprovals[0]!;
    resolveApproval(req.id, true, ALLOWED_USER);
    await run({
      threadTs: '1700000000.999999',
      channelId: CHANNEL,
      userId: ALLOWED_USER,
      approvalResponse: { approvalId: req.approvalId, approved: true },
    }).catch(() => undefined);
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('(reviewer) an approved=true response for a row the DB never approved does not execute', async () => {
    // Defense in depth for A13: the agent should not trust approvalResponse alone.
    const { r1 } = await pauseOnBash();
    const req = r1.pendingApprovals[0]!;
    // no resolveApproval(): row is still PENDING
    await run({
      threadTs: THREAD,
      channelId: CHANNEL,
      userId: ALLOWED_USER,
      approvalResponse: { approvalId: req.approvalId, approved: true },
    }).catch(() => undefined);
    expect(h.execute).not.toHaveBeenCalled();
    expect(getApprovalByApprovalId(req.approvalId)?.status).toBe('PENDING');
  });

  it('tools are built per turn with this thread in the context (A02)', async () => {
    await pauseOnBash();
    const ctx = h.contexts.at(-1) as ToolContext;
    expect(ctx.threadTs).toBe(THREAD);
    expect(ctx.channelId).toBe(CHANNEL);
    expect(ctx.userId).toBe(ALLOWED_USER);
    expect(ctx.turnState).toEqual({ browserUsed: false });
    expect(ctx.slack).toBe(slack);
    expect(ctx.scheduler).toBe(scheduler);
  });
});

describe.skipIf(!ready)('one turn at a time per thread (A05)', () => {
  it('two concurrent turns on one thread persist both messages, in order', async () => {
    useModel(scriptedModel([textResult('reply one'), textResult('reply two')], { delayMs: 40 }));
    const [a, b] = await Promise.all([
      run({ threadTs: THREAD, channelId: CHANNEL, userId: ALLOWED_USER, userMessage: 'first message' }),
      run({ threadTs: THREAD, channelId: CHANNEL, userId: ALLOWED_USER, userMessage: 'second message' }),
    ]);
    expect(a.text).toBe('reply one');
    expect(b.text).toBe('reply two');
    const msgs = getThread(THREAD)!.messages;
    expect(userTexts(msgs).map((t) => (t.includes('first') ? 'first' : t.includes('second') ? 'second' : t))).toEqual([
      'first',
      'second',
    ]);
    const flat = JSON.stringify(msgs);
    expect(flat.indexOf('reply one')).toBeGreaterThan(flat.indexOf('first message'));
    expect(flat.indexOf('second message')).toBeGreaterThan(flat.indexOf('reply one'));
    expect(flat.indexOf('reply two')).toBeGreaterThan(flat.indexOf('second message'));
    expect(isThreadLocked(THREAD)).toBe(false);
  });

  it('the second turn sees the first turn in its prompt', async () => {
    const m = useModel(scriptedModel([textResult('reply one'), textResult('reply two')], { delayMs: 20 }));
    await Promise.all([
      run({ threadTs: THREAD, channelId: CHANNEL, userId: ALLOWED_USER, userMessage: 'first message' }),
      run({ threadTs: THREAD, channelId: CHANNEL, userId: ALLOWED_USER, userMessage: 'second message' }),
    ]);
    expect(JSON.stringify(m.calls[1]?.prompt)).toContain('reply one');
  });

  it('a failed turn releases the lock and the next turn still works', async () => {
    h.model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error('provider down');
      },
    });
    await expect(run({ threadTs: THREAD, channelId: CHANNEL, userId: ALLOWED_USER, userMessage: 'x' })).rejects.toThrow();
    expect(isThreadLocked(THREAD)).toBe(false);
    useModel(scriptedModel([textResult('recovered')]));
    const r = await run({ threadTs: THREAD, channelId: CHANNEL, userId: ALLOWED_USER, userMessage: 'again' });
    expect(r.text).toBe('recovered');
  });
});

describe.skipIf(!ready)('context budget on the wire (A06)', () => {
  it('a huge tool result is truncated before it reaches the model', async () => {
    const m = useModel(scriptedModel([toolCallResult('call-big', 'big_output', {}), textResult('summarized')]));
    await run({ threadTs: THREAD, channelId: CHANNEL, userId: ALLOWED_USER, userMessage: 'dump' });
    const prompt = JSON.stringify(m.calls.at(-1)?.prompt);
    expect(prompt).toContain('BIG_HEAD');
    expect(prompt).toContain('BIG_TAIL');
    expect(prompt).toMatch(/\[truncated \d+ chars\]/);
    expect(prompt.length).toBeLessThan(40_000);
  });

  it('history sent to the model is capped at HISTORY_MAX_MESSAGES', async () => {
    applyEnv({ DATA_DIR: env.dataDir, HISTORY_MAX_MESSAGES: '10' });
    run = agentMod!.createAgentRunner!({ slack, scheduler }); // in case config is read at creation
    const m = useModel(scriptedModel([], { fallbackText: 'ok' }));
    for (let i = 0; i < 8; i++) {
      await run({ threadTs: THREAD, channelId: CHANNEL, userId: ALLOWED_USER, userMessage: `msg ${i}` });
    }
    const nonSystem = (m.calls.at(-1)?.prompt ?? []).filter((p) => p.role !== 'system');
    expect(nonSystem.length).toBeLessThanOrEqual(10);
    expect(JSON.stringify(nonSystem)).toContain('msg 7');
  });
});

describe.skipIf(!ready)('system prompt (spec Phase 4/5)', () => {
  it('includes MEMORY.md and the active model id', async () => {
    if (skills) await skills.appendMemoryRule('Always reply in haiku.', 'rule');
    const m = useModel(scriptedModel([textResult('ok')]));
    await run({ threadTs: THREAD, channelId: CHANNEL, userId: ALLOWED_USER, userMessage: 'hi' });
    const sys = systemText(m);
    if (skills) expect(sys).toContain('Always reply in haiku.');
    expect(sys).toContain('mock:mock-model');
  });

  it('(reviewer) secrets from the environment never appear in the prompt or messages_json', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-PROMPTLEAK-123';
    const m = useModel(scriptedModel([textResult('ok')]));
    await run({ threadTs: THREAD, channelId: CHANNEL, userId: ALLOWED_USER, userMessage: 'hi' });
    expect(JSON.stringify(m.calls)).not.toContain('PROMPTLEAK');
    expect(JSON.stringify(getThread(THREAD)?.messages)).not.toContain('PROMPTLEAK');
  });
});

if (!(ready)) describe('createAgentRunner not written yet (Wave 2)', () => {
  it.todo('A03/A13 approval round-trip');
  it.todo('A05 concurrent turns on one thread');
  it.todo('A06 truncation and history cap on the wire');
});
