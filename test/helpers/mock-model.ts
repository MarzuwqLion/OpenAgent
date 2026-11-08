/**
 * Scripted MockLanguageModelV4 (from `ai/test`): returns the given results in
 * order and records every call's options (prompt, tools) for assertions.
 * After the script is exhausted it keeps returning a plain text reply.
 */
import { MockLanguageModelV4 } from 'ai/test';

type GenerateResult = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;
type CallOptions = MockLanguageModelV4['doGenerateCalls'][number];

const usage: GenerateResult['usage'] = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

export function textResult(text: string): GenerateResult {
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage,
    warnings: [],
  } as GenerateResult;
}

export function toolCallResult(toolCallId: string, toolName: string, input: unknown): GenerateResult {
  return {
    content: [{ type: 'tool-call', toolCallId, toolName, input: JSON.stringify(input) }],
    finishReason: { unified: 'tool-calls', raw: 'tool_use' },
    usage,
    warnings: [],
  } as GenerateResult;
}

export interface ScriptedModel {
  model: MockLanguageModelV4;
  calls: CallOptions[];
}

export function scriptedModel(
  script: GenerateResult[],
  opts: { delayMs?: number; modelId?: string; fallbackText?: string } = {},
): ScriptedModel {
  const queue = [...script];
  const calls: CallOptions[] = [];
  const model = new MockLanguageModelV4({
    provider: 'mock',
    modelId: opts.modelId ?? 'mock-model',
    doGenerate: async (options) => {
      calls.push(options);
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      return queue.shift() ?? textResult(opts.fallbackText ?? 'ok');
    },
  });
  return { model, calls };
}
