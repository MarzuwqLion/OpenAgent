/**
 * Baseline: proves the installed `ai` package's native tool approval works the
 * way A03 assumes (stop on needsApproval → approval-response part → SDK runs
 * the tool exactly once, or reports the denial). If this file fails after an
 * `ai` upgrade, agent.ts's approval flow is built on a broken assumption.
 */
import { describe, expect, it, vi } from 'vitest';
import { generateText, stepCountIs, tool, type ModelMessage } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import { scriptedModel, toolCallResult, textResult } from './helpers/mock-model.js';

function makeBash(execute: (input: { command: string }) => Promise<string>) {
  return tool({
    description: 'run a shell command',
    inputSchema: z.object({ command: z.string() }),
    needsApproval: true,
    execute,
  });
}

describe('AI SDK native approval (installed version)', () => {
  it('MockLanguageModelV4 is exported from ai/test', () => {
    expect(typeof MockLanguageModelV4).toBe('function');
  });

  it('stops with a tool-approval-request, then executes once on approval', async () => {
    const execute = vi.fn(async () => 'TOOL_OUTPUT_MARKER');
    const { model, calls } = scriptedModel([toolCallResult('call-1', 'bash', { command: 'ls' }), textResult('all done')]);
    const tools = { bash: makeBash(execute) };
    const history: ModelMessage[] = [{ role: 'user', content: 'list files' }];

    const r1 = await generateText({ model, tools, messages: history, stopWhen: stepCountIs(15) });
    const approvals = r1.content.filter((p) => p.type === 'tool-approval-request');
    expect(approvals).toHaveLength(1);
    expect(execute).not.toHaveBeenCalled();
    const approval = approvals[0]!;
    expect(approval.type === 'tool-approval-request' && approval.toolCall.toolName).toBe('bash');

    history.push(...r1.response.messages);
    history.push({
      role: 'tool',
      content: [{ type: 'tool-approval-response', approvalId: (approval as { approvalId: string }).approvalId, approved: true }],
    });
    const r2 = await generateText({ model, tools, messages: history, stopWhen: stepCountIs(15) });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(r2.text).toBe('all done');
    expect(JSON.stringify(calls.at(-1)?.prompt)).toContain('TOOL_OUTPUT_MARKER');
  });

  it('reports a denial to the model without executing', async () => {
    const execute = vi.fn(async () => 'SHOULD_NOT_RUN');
    const { model, calls } = scriptedModel([toolCallResult('call-1', 'bash', { command: 'rm -rf x' }), textResult('ok, not done')]);
    const tools = { bash: makeBash(execute) };
    const history: ModelMessage[] = [{ role: 'user', content: 'delete x' }];
    const r1 = await generateText({ model, tools, messages: history, stopWhen: stepCountIs(15) });
    const approval = r1.content.find((p) => p.type === 'tool-approval-request') as { approvalId: string } | undefined;
    expect(approval).toBeDefined();
    history.push(...r1.response.messages, {
      role: 'tool',
      content: [{ type: 'tool-approval-response', approvalId: approval!.approvalId, approved: false, reason: 'no' }],
    });
    await generateText({ model, tools, messages: history, stopWhen: stepCountIs(15) });
    expect(execute).not.toHaveBeenCalled();
    expect(JSON.stringify(calls.at(-1)?.prompt)).toMatch(/denied/i);
  });
});
