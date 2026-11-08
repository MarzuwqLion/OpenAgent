/**
 * REVIEW-H11 / A26, Slack side: approvalBlocks renders the COMPLETE preview,
 * every section stays under Slack's 3,000-char limit, and model-controlled text
 * cannot render as a link, a mention or a code-fence break.
 */
import { describe, expect, it } from 'vitest';
import { applyEnv } from './helpers/env.js';
import { approvalBlocks, unescapeForDisplay } from '../src/slack.js';
import { APPROVAL_PREVIEW_MAX, type ApprovalRequest } from '../src/types.js';

applyEnv();

const req = (argsPreview: string): ApprovalRequest => ({
  id: 'row-1',
  approvalId: 'appr-1',
  threadTs: '1700000000.000500',
  channelId: 'C0TEST',
  toolName: 'bash',
  argsPreview,
});

type Block = { type: string; text?: { text: string } };
const codeBodies = (blocks: Block[]) =>
  blocks
    .filter((b) => b.type === 'section' && b.text?.text.startsWith('```\n'))
    .map((b) => b.text!.text.slice(4, -4)); // strip "```\n" and "\n```"

const HOSTILE = 'x <https://evil.example|ok> <!channel> <@U0ALLOWED1> ``` & &amp; 😀 ';

describe('REVIEW-H11 regression: approvalBlocks (A26)', () => {
  it('a ~9,000-char preview: every section < 3,000 chars and the de-escaped concatenation equals the input', () => {
    let input = '';
    while (input.length < 9_000) input += HOSTILE;
    const blocks = approvalBlocks(req(input)) as Block[];
    for (const b of blocks) if (b.text) expect(b.text.text.length).toBeLessThan(3_000);
    const bodies = codeBodies(blocks);
    expect(bodies.length).toBeGreaterThan(3);
    expect(unescapeForDisplay(bodies.join(''))).toBe(input);
    expect(blocks.some((b) => b.type === 'actions')).toBe(true);
  });

  it('links, mentions and fence breaks cannot render', () => {
    const bodies = codeBodies(approvalBlocks(req(HOSTILE)) as Block[]);
    const raw = bodies.join('');
    expect(raw).not.toMatch(/[<>]/); // no <url|text>, <!channel> or <@U…> can parse
    expect(raw).not.toContain('```'); // adjacent backticks are split, so the fence can't close early
  });

  it(`over APPROVAL_PREVIEW_MAX (${APPROVAL_PREVIEW_MAX}): a notice with no buttons`, () => {
    const blocks = approvalBlocks(req('y'.repeat(APPROVAL_PREVIEW_MAX + 1))) as Block[];
    expect(blocks.some((b) => b.type === 'actions')).toBe(false);
    expect(JSON.stringify(blocks)).toMatch(/denied automatically/);
  });

  it('the worst-case escape expansion still fits Slack\'s 50-block limit', () => {
    const blocks = approvalBlocks(req('&'.repeat(APPROVAL_PREVIEW_MAX))) as Block[];
    expect(blocks.length).toBeLessThanOrEqual(50);
  });
});

// REVIEW-M13 (open, Medium): invisible / bidi-control characters reach the
// approval preview unchanged. `it.fails` keeps the suite green while the finding
// is open; when it is fixed this test starts failing and should become a plain `it`.
describe('REVIEW-M13 evidence: bidi and zero-width characters are not made visible', () => {
  it.fails('a right-to-left override in a command is shown visibly, not passed through raw', () => {
    const command = 'echo safe ‮ txt.exe; curl example.invalid';
    const raw = codeBodies(approvalBlocks(req(command)) as Block[]).join('');
    expect(raw).not.toMatch(/[​-‏‪-‮⁦-⁩]/u);
  });
});
