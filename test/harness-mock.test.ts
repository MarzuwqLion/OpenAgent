/**
 * Harness self-test: vi.mock of a src module applies to modules loaded through
 * loadSrc() (file-URL dynamic import). agent.test.ts relies on this to swap
 * llm.resolveModel and tools/index.createTools for createAgentRunner.
 */
import { describe, expect, it, vi } from 'vitest';
import { applyEnv } from './helpers/env.js';
import { loadSrc, srcExists, type AgentModule } from './helpers/modules.js';

vi.mock('../src/tools/util.js', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return { ...real, truncateToolResult: () => 'MOCKED_BY_VI' };
});

applyEnv();
const agent = srcExists('tools/util.js') ? await loadSrc<AgentModule>('agent.js') : null;

describe.skipIf(!agent)('vi.mock reaches modules loaded via loadSrc', () => {
  it('agent.ts sees the mocked tools/util.js export', () => {
    expect(agent!.truncateToolResult('x'.repeat(50_000))).toBe('MOCKED_BY_VI');
  });
});
