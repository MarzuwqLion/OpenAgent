/**
 * REVIEW-M3 regression (agent.ts supersede path): when a new user message
 * arrives while a paused step has one sibling APPROVED and one still PENDING,
 * the approved call runs exactly once, the pending one is cancelled, and a late
 * or replayed approval never runs anything a second time.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getApprovalByApprovalId, getThread, resolveApproval } from '../src/db.js';
import type { AgentRunner } from '../src/types.js';
import { ALLOWED_USER, applyEnv, setupTestEnv, type TestEnv } from './helpers/env.js';
import { FakeSchedulerPort, FakeSlackPort } from './helpers/fakes.js';
import { scriptedModel, textResult } from './helpers/mock-model.js';
import { loadSrc, type AgentModule, type SkillsModule } from './helpers/modules.js';

const h = vi.hoisted(() => ({
  model: undefined as unknown,
  execute: vi.fn(async (input: { command: string }) => `OUT:${input.command}`),
}));

vi.mock('../src/llm.js', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return { ...real, resolveModel: () => ({ modelId: 'mock:mock-model', model: h.model }) };
});

vi.mock('../src/tools/index.js', async () => {
  const { tool } = await import('ai');
  const { z } = await import('zod');
  return {
    createTools: () => ({
      bash: tool({
        description: 'Run a shell command',
        inputSchema: z.object({ command: z.string() }),
        needsApproval: true,
        execute: async (input: { command: string }) => h.execute(input),
      }),
    }),
  };
});

applyEnv();
const agentMod = await loadSrc<AgentModule>('agent.js');
const skills = await loadSrc<SkillsModule>('skills.js');

const THREAD = '1700000000.000300';
const CHANNEL = 'C0TEST';
let env: TestEnv;
let run: AgentRunner;

beforeEach(async () => {
  env = await setupTestEnv();
  await skills?.initDataRepo();
  h.execute.mockClear();
  run = agentMod!.createAgentRunner!({ slack: new FakeSlackPort(), scheduler: new FakeSchedulerPort() });
});
afterEach(async () => {
  await env.cleanup();
});

const twoCalls = {
  content: [
    { type: 'tool-call', toolCallId: 'call-A', toolName: 'bash', input: JSON.stringify({ command: 'echo A' }) },
    { type: 'tool-call', toolCallId: 'call-B', toolName: 'bash', input: JSON.stringify({ command: 'echo B' }) },
  ],
  finishReason: { unified: 'tool-calls', raw: 'tool_use' },
  usage: textResult('').usage,
  warnings: [],
} as unknown as ReturnType<typeof textResult>;

describe.skipIf(!agentMod?.createAgentRunner)('REVIEW-M3 regression: approved sibling survives a new message', () => {
  it('runs the APPROVED sibling once, cancels the PENDING one, and ignores a replay', async () => {
    const m = scriptedModel([twoCalls, textResult('ok, moving on')]);
    h.model = m.model;

    const r1 = await run({ threadTs: THREAD, channelId: CHANNEL, userId: ALLOWED_USER, userMessage: 'run both' });
    expect(r1.pendingApprovals).toHaveLength(2);
    const [a, b] = r1.pendingApprovals as [(typeof r1.pendingApprovals)[0], (typeof r1.pendingApprovals)[0]];
    const reqA = a.argsPreview.includes('echo A') ? a : b;
    const reqB = reqA === a ? b : a;

    // Approve A: the step still waits on B, so nothing runs yet.
    expect(resolveApproval(reqA.id, true, ALLOWED_USER)).toBe(true);
    await run({ threadTs: THREAD, channelId: CHANNEL, userId: ALLOWED_USER, approvalResponse: { approvalId: reqA.approvalId, approved: true } });
    expect(h.execute).not.toHaveBeenCalled();

    // New message supersedes: A runs once, B is cancelled.
    await run({ threadTs: THREAD, channelId: CHANNEL, userId: ALLOWED_USER, userMessage: 'never mind B' });
    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(h.execute.mock.calls[0]![0]).toEqual({ command: 'echo A' });
    expect(getApprovalByApprovalId(reqB.approvalId)).toMatchObject({ status: 'REJECTED', decidedBy: 'system:superseded' });
    const stored = JSON.stringify(getThread(THREAD)?.messages);
    expect(stored).toContain('OUT:echo A');
    expect(stored).toContain('execution-denied');
    expect(JSON.stringify(m.calls.at(-1)?.prompt)).toMatch(/already approved were run/);

    // A late click on B fails; a replayed resume for A runs nothing again.
    expect(resolveApproval(reqB.id, true, ALLOWED_USER)).toBe(false);
    await run({ threadTs: THREAD, channelId: CHANNEL, userId: ALLOWED_USER, approvalResponse: { approvalId: reqA.approvalId, approved: true } }).catch(() => undefined);
    expect(h.execute).toHaveBeenCalledTimes(1);
  });
});
