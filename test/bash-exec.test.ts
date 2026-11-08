/**
 * The real bash tool's execute() on the host (no uid switch; A09 needs the
 * container). Proves A10 env scrubbing, the workspace cwd and A06 output
 * truncation end to end. On Windows this relies on Git Bash; it is skipped
 * when a probe command cannot run.
 */
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyEnv, setupTestEnv, type TestEnv } from './helpers/env.js';
import { makeToolContext } from './helpers/fakes.js';
import { executeTool, loadSrc, type ToolsModule } from './helpers/modules.js';

applyEnv();
const tools = await loadSrc<ToolsModule>('tools/index.js');

async function probe(): Promise<boolean> {
  if (!tools) return false;
  const env = await setupTestEnv();
  try {
    const out = await executeTool(tools.createTools(makeToolContext()).bash, { command: 'echo probe-ok' });
    return String(out).includes('probe-ok');
  } catch {
    return false;
  } finally {
    await env.cleanup();
  }
}
const canExec = await probe();

let env: TestEnv;
beforeEach(async () => {
  env = await setupTestEnv();
});
afterEach(async () => {
  await env.cleanup();
});

const run = async (command: string) =>
  String(await executeTool(tools!.createTools(makeToolContext()).bash, { command }));

describe.skipIf(!canExec)('bash tool execution on the host (A10, A06)', () => {
  it('env contains no *_KEY / *_TOKEN and none of the secret values', async () => {
    const secrets = {
      SLACK_BOT_TOKEN: 'xoxb-exec-leak-111',
      SLACK_APP_TOKEN: 'xapp-exec-leak-222',
      ANTHROPIC_API_KEY: 'sk-ant-exec-leak-333',
      OPENAI_API_KEY: 'sk-openai-exec-leak-444',
      FAKE_SERVICE_TOKEN: 'tok-exec-leak-555',
    };
    Object.assign(process.env, secrets);
    const out = await run('env');
    expect(out).not.toMatch(/^[A-Z0-9_]*(_KEY|_TOKEN|_SECRET)=/m);
    for (const v of Object.values(secrets)) expect(out).not.toContain(v);
  });

  it('runs in the workspace with HOME = workspace', async () => {
    const out = await run('pwd; echo "HOME=$HOME"');
    expect(out).toMatch(/workspace\s/);
    // Git Bash on Windows may rewrite the path to /c/...; compare the tail only.
    expect(out).toMatch(/HOME=\S*workspace\s/);
    expect(path.basename(env.paths.workspace)).toBe('workspace');
  });

  it('a huge output is truncated (A06)', async () => {
    const out = await run('i=0; while [ $i -lt 3000 ]; do echo "line $i xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"; i=$((i+1)); done');
    expect(out.length).toBeLessThanOrEqual(20_064);
    expect(out).toMatch(/\[truncated \d+ chars\]/);
    expect(out).toContain('line 2999');
  });

  it('a failing command returns its exit code instead of throwing', async () => {
    const out = await run('echo before; exit 3');
    expect(out).toContain('before');
    expect(out).toMatch(/\b3\b/);
  });
});

if (!(canExec)) describe('bash tool execution on the host', () => {
  it.todo('skipped: bash could not be spawned on this host');
});
