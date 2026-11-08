/**
 * A06 context budget: truncateToolResult and trimHistory (pure helpers in agent.ts).
 */
import type { ModelMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { applyEnv } from './helpers/env.js';
import { loadSrc, type AgentModule } from './helpers/modules.js';

applyEnv();
const agent = await loadSrc<AgentModule>('agent.js');

const MARKER = /\[truncated (\d+) chars\]/;

function checkTruncation(text: string, out: string, max: number) {
  const m = MARKER.exec(out);
  expect(m, 'marker present').not.toBeNull();
  const n = Number(m![1]);
  const head = out.slice(0, m!.index).replace(/\s+$/, '');
  const tail = out.slice(m!.index + m![0].length).replace(/^\s+/, '');
  expect(text.startsWith(head), 'head is a prefix').toBe(true);
  expect(text.endsWith(tail), 'tail is a suffix').toBe(true);
  expect(head.length).toBeGreaterThan(0);
  expect(tail.length).toBeGreaterThan(0);
  expect(n, 'N = chars removed').toBe(text.length - head.length - tail.length);
  expect(out.length).toBeLessThanOrEqual(max + 64);
}

describe.skipIf(!agent)('truncateToolResult (A06)', () => {
  it('returns short text unchanged, including exactly max', () => {
    expect(agent!.truncateToolResult('hello')).toBe('hello');
    const exact = 'a'.repeat(20_000);
    expect(agent!.truncateToolResult(exact)).toBe(exact);
    expect(agent!.truncateToolResult('')).toBe('');
  });

  it('keeps head and tail with a [truncated N chars] marker (default 20,000)', () => {
    const text = `HEAD_MARKER${'x'.repeat(50_000)}TAIL_MARKER`;
    const out = agent!.truncateToolResult(text);
    expect(out.startsWith('HEAD_MARKER')).toBe(true);
    expect(out.endsWith('TAIL_MARKER')).toBe(true);
    checkTruncation(text, out, 20_000);
  });

  it('truncates 20,001 chars', () => {
    const text = 'y'.repeat(20_001);
    const out = agent!.truncateToolResult(text);
    expect(out).not.toBe(text);
    checkTruncation(text, out, 20_000);
  });

  it('honours a custom max', () => {
    const text = `H${'z'.repeat(1_000)}T`;
    const out = agent!.truncateToolResult(text, 100);
    expect(out.startsWith('H')).toBe(true);
    expect(out.endsWith('T')).toBe(true);
    checkTruncation(text, out, 100);
  });
});

// ─── trimHistory ───────────────────────────────────────────────────────────

const user = (text: string): ModelMessage => ({ role: 'user', content: text });
const say = (text: string): ModelMessage => ({ role: 'assistant', content: [{ type: 'text', text }] });
const call = (...ids: string[]): ModelMessage => ({
  role: 'assistant',
  content: ids.map((id) => ({ type: 'tool-call' as const, toolCallId: id, toolName: 'bash', input: { command: 'ls' } })),
});
const result = (...ids: string[]): ModelMessage => ({
  role: 'tool',
  content: ids.map((id) => ({
    type: 'tool-result' as const,
    toolCallId: id,
    toolName: 'bash',
    output: { type: 'text' as const, value: `out ${id}` },
  })),
});

const FIXTURE: ModelMessage[] = [
  user('q0'),
  { role: 'assistant', content: [{ type: 'text', text: 'let me look' }, { type: 'tool-call', toolCallId: 'c1', toolName: 'bash', input: { command: 'ls' } }] },
  result('c1'),
  say('a1'),
  user('q1'),
  call('c2', 'c3'), // parallel calls
  result('c2'), // results split over two tool messages
  result('c3'),
  call('c4'),
  result('c4'),
  call('c5', 'c6'),
  result('c5', 'c6'),
  say('a2'),
  user('q2'),
];

function partsOf(m: ModelMessage): { type: string; toolCallId?: string }[] {
  return Array.isArray(m.content) ? (m.content as { type: string; toolCallId?: string }[]) : [];
}

function assertWellFormed(out: ModelMessage[], input: ModelMessage[], max: number) {
  expect(out.length).toBeLessThanOrEqual(max);
  // newest messages kept: the output is a contiguous suffix of the input
  expect(out).toEqual(input.slice(input.length - out.length));
  if (out.length > 0) expect(out[0]!.role, 'must not start with a tool message').not.toBe('tool');
  const calls = new Set<string>();
  const results = new Set<string>();
  for (const m of out) {
    for (const p of partsOf(m)) {
      if (m.role === 'assistant' && p.type === 'tool-call') calls.add(p.toolCallId!);
      if (m.role === 'tool' && p.type === 'tool-result') {
        expect(calls.has(p.toolCallId!), `result ${p.toolCallId} without its call`).toBe(true);
        results.add(p.toolCallId!);
      }
    }
  }
  for (const id of calls) expect(results.has(id), `call ${id} without its result`).toBe(true);
}

describe.skipIf(!agent)('trimHistory (A06)', () => {
  it('returns everything when under the cap', () => {
    expect(agent!.trimHistory(FIXTURE, 120)).toEqual(FIXTURE);
    expect(agent!.trimHistory(FIXTURE, FIXTURE.length)).toEqual(FIXTURE);
  });

  it('never orphans a tool call or result, for every cap', () => {
    for (let max = 1; max <= FIXTURE.length; max++) {
      const out = agent!.trimHistory(FIXTURE, max);
      assertWellFormed(out, FIXTURE, max);
      // the newest user message is always kept when it is last
      if (max >= 1) expect(out.at(-1), `max=${max}`).toEqual(user('q2'));
    }
  });

  it('never orphans pairs when the newest messages are a tool exchange', () => {
    const h = [user('q'), call('x1'), result('x1'), call('x2', 'x3'), result('x2'), result('x3')];
    for (let max = 1; max <= h.length; max++) assertWellFormed(agent!.trimHistory(h, max), h, max);
  });

  it('does not mutate its input', () => {
    const copy = structuredClone(FIXTURE);
    agent!.trimHistory(FIXTURE, 3);
    expect(FIXTURE).toEqual(copy);
  });

  it('drops the oldest messages first (keeps as much recent context as allowed)', () => {
    const long: ModelMessage[] = Array.from({ length: 300 }, (_, i) => (i % 2 ? say(`a${i}`) : user(`q${i}`)));
    const out = agent!.trimHistory(long, 120);
    expect(out.length).toBeGreaterThanOrEqual(119);
    expect(out.at(-1)).toEqual(long.at(-1));
  });

  it('(reviewer) keeps a trailing tool call that is awaiting approval, so the turn can resume', () => {
    // A03: a paused turn ends with assistant{tool-call, tool-approval-request}
    // followed by tool{tool-approval-response}. Trimming must not drop the call,
    // or the SDK cannot match the approval response on resume.
    const pending: ModelMessage[] = [
      user('q0'),
      say('a0'),
      user('delete x'),
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'p1', toolName: 'bash', input: { command: 'rm x' } },
          { type: 'tool-approval-request', approvalId: 'ap1', toolCallId: 'p1' },
        ],
      },
      { role: 'tool', content: [{ type: 'tool-approval-response', approvalId: 'ap1', approved: true }] },
    ];
    const out = agent!.trimHistory(pending, 3);
    const flat = JSON.stringify(out);
    expect(flat).toContain('"toolCallId":"p1"');
    expect(flat).toContain('tool-approval-response');
  });
});

if (!(agent)) describe('agent.ts not written yet', () => {
  it.todo('truncateToolResult / trimHistory');
});
