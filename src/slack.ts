/**
 * Slack gateway (Bolt, Socket Mode). Owned by Integration.
 *
 * Handlers are thin; routing, auth, dedupe, splitting and formatting live in
 * pure exported helpers. Only index.ts imports this file (A01).
 *
 * Amendments: A07 access control, A13 approval buttons, A15 dedupe,
 * A16 output formatting/splitting, A17 reaction lifecycle.
 */
import fs from 'node:fs';
import path from 'node:path';
import { App, LogLevel, type types } from '@slack/bolt';
type KnownBlock = types.KnownBlock;
import { dataPaths, getConfig } from './config.js';
import {
  ensureThread,
  getApproval,
  getGlobalModel,
  getThread,
  resolveApproval,
  setApprovalMessageTs,
  setGlobalModel,
} from './db.js';
import { listAvailableModels, validateModelId } from './llm.js';
import { APPROVAL_PREVIEW_MAX } from './types.js';
import type { AgentRunner, ApprovalRequest, SlackPort } from './types.js';

// ─── Pure helpers ───────────────────────────────────────────────────────────

/** A07: only members listed in ALLOWED_SLACK_USER_IDS may use the bot. Read at call time. */
export function isAllowedUser(userId: string | undefined | null): boolean {
  if (typeof userId !== 'string' || userId === '') return false;
  return getConfig().ALLOWED_SLACK_USER_IDS.includes(userId);
}

const DEDUPE_MAX_KEYS = 10_000;

/** A15: bounded LRU of processed `channel:ts` keys. The returned fn gives true the first time a key is seen. */
export function createEventDeduper(maxKeys: number = DEDUPE_MAX_KEYS): (key: string) => boolean {
  const seen = new Map<string, true>();
  return (key: string): boolean => {
    if (seen.has(key)) {
      // refresh recency
      seen.delete(key);
      seen.set(key, true);
      return false;
    }
    seen.set(key, true);
    if (seen.size > maxKeys) {
      const oldest = seen.keys().next().value;
      if (oldest !== undefined) seen.delete(oldest);
    }
    return true;
  };
}

export const SLACK_SPLIT_LIMIT = 3_500;

/**
 * A16: split text into chunks of at most `limit` chars, preferring paragraph,
 * then line, then word boundaries; hard-splits when there are none. Chunks are
 * trimmed and never empty; no non-whitespace character is lost.
 */
export function splitForSlack(text: string, limit: number = SLACK_SPLIT_LIMIT): string[] {
  const max = Math.max(1, Math.floor(limit));
  const out: string[] = [];
  let rest = text;
  const push = (s: string) => {
    const t = s.trim();
    if (t !== '') out.push(t);
  };
  while (rest.length > max) {
    const window = rest.slice(0, max + 1);
    const minCut = Math.floor(max / 2);
    let cut = window.lastIndexOf('\n\n');
    if (cut < minCut) cut = window.lastIndexOf('\n');
    if (cut < minCut) cut = window.lastIndexOf(' ');
    if (cut < minCut) {
      cut = max;
      const prev = rest.charCodeAt(cut - 1);
      if (prev >= 0xd800 && prev <= 0xdbff && cut > 1) cut -= 1; // don't split a surrogate pair
    }
    push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  push(rest);
  return out;
}

/** Keep ``` fences balanced when a code block was split across chunks (adds at most 8 chars per chunk). */
export function balanceFences(chunks: string[]): string[] {
  let open = false;
  return chunks.map((chunk) => {
    let c = open ? '```\n' + chunk : chunk;
    const count = (c.match(/```/g) ?? []).length;
    open = count % 2 === 1;
    if (open) c += '\n```';
    return c;
  });
}

/** A16: chunks ready to post: split, fence-balanced. */
export function formatForSlack(text: string, limit: number = SLACK_SPLIT_LIMIT): string[] {
  return balanceFences(splitForSlack(text, limit));
}

/** One line for the thread when a turn fails (A17). Never echoes key-like strings. */
export function safeErrorLine(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const cleaned = raw
    .replace(/\b(?:sk|xox[a-z]|xapp|AIza|key|token)[-_A-Za-z0-9.]{6,}/gi, '[redacted]')
    .replace(/[A-Za-z0-9_\-.]{24,}/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
  return `:x: Sorry, that failed${cleaned ? `: ${cleaned}` : ''}. The full error is in the server logs.`;
}

/** Slack's required escapes, so text can't become a link, mention or hidden label (<https://evil|ok>, <!channel>). */
export function escapeMrkdwn(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const ZWSP = '​';

/** Insert a zero-width space between adjacent backticks so the text can never close a code fence. */
export function neutralizeBackticks(s: string): string {
  return s.replace(/`(?=`)/g, '`' + ZWSP);
}

/** Reverse of escapeMrkdwn + neutralizeBackticks (for tests and reviewers). */
export function unescapeForDisplay(s: string): string {
  return s.split(ZWSP).join('').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

const SECTION_TEXT_LIMIT = 3_000;
const FENCE_OPEN = '```\n';
const FENCE_CLOSE = '\n```';

/**
 * A26: render the ENTIRE text as code-fenced sections, each under Slack's 3,000-char limit.
 * No character is dropped; the only changes are Slack escapes and zero-width spaces.
 * Fences sit on their own lines, so content never touches them.
 */
export function codeSections(text: string): string[] {
  const safe = neutralizeBackticks(text);
  const budget = SECTION_TEXT_LIMIT - FENCE_OPEN.length - FENCE_CLOSE.length - 20;
  const pieces: string[] = [];
  let cur = '';
  for (const ch of safe) {
    // iterates by code point, so surrogate pairs stay together
    const esc = escapeMrkdwn(ch);
    if (cur.length + esc.length > budget) {
      pieces.push(cur);
      cur = '';
    }
    cur += esc;
  }
  if (cur !== '' || pieces.length === 0) pieces.push(cur);
  return pieces.map((p) => FENCE_OPEN + p + FENCE_CLOSE);
}

/** First section only: for the shortened post-decision and expiry messages. */
function codeBlock(s: string): string {
  return codeSections(s)[0]!;
}

function slackDate(ms: number): string {
  return `<!date^${Math.floor(ms / 1000)}^{date_short_pretty} at {time}|${new Date(ms).toISOString()}>`;
}

/**
 * Block Kit for the approval request: tool name, the COMPLETE args (A26) and Approve/Reject.
 * If the preview is over APPROVAL_PREVIEW_MAX, returns a notice with NO buttons: the agent
 * auto-denies such calls, and a human must never be asked to approve text they can't fully see.
 */
export function approvalBlocks(req: ApprovalRequest): KnownBlock[] {
  const tool = escapeMrkdwn(req.toolName.replace(/`/g, ''));
  if (req.argsPreview.length > APPROVAL_PREVIEW_MAX) {
    return [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:no_entry: \`${tool}\` was denied automatically: its arguments are too long to review (over ${APPROVAL_PREVIEW_MAX} characters).`,
        },
      },
    ];
  }
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `:lock: *Approval needed:* \`${tool}\`` },
    },
    ...codeSections(req.argsPreview).map((text): KnownBlock => ({ type: 'section', text: { type: 'mrkdwn', text } })),
    {
      type: 'actions',
      block_id: `approval_${req.id}`,
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Approve' },
          style: 'primary',
          action_id: `approve_tool_${req.id}`,
          value: req.id,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Reject' },
          style: 'danger',
          action_id: `reject_tool_${req.id}`,
          value: req.id,
        },
      ],
    },
  ];
}

/** A13: the message after a decision: who decided and when; buttons removed. */
export function decidedBlocks(opts: {
  toolName: string;
  argsPreview: string;
  verdict: 'Approved' | 'Rejected' | 'Expired';
  userId?: string;
  at: number;
}): KnownBlock[] {
  const icon = opts.verdict === 'Approved' ? ':white_check_mark:' : opts.verdict === 'Rejected' ? ':no_entry_sign:' : ':hourglass:';
  const who = opts.userId ? ` by <@${opts.userId}>` : '';
  return [
    { type: 'section', text: { type: 'mrkdwn', text: `${icon} \`${escapeMrkdwn(opts.toolName.replace(/`/g, ''))}\` *${opts.verdict}*${who} on ${slackDate(opts.at)}` } },
    { type: 'section', text: { type: 'mrkdwn', text: codeBlock(opts.argsPreview.slice(0, 2_500)) } },
  ];
}

export function previewArgs(args: unknown): string {
  if (typeof args === 'string') return args.slice(0, 500);
  try {
    const o = args as Record<string, unknown> | null;
    if (o && typeof o === 'object' && typeof o.command === 'string' && Object.keys(o).length === 1) return o.command.slice(0, 500);
    return JSON.stringify(args, null, 2).slice(0, 500);
  } catch {
    return String(args).slice(0, 500);
  }
}

// ─── Bolt app ───────────────────────────────────────────────────────────────

interface MessageEventLike {
  type?: string;
  subtype?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  channel?: string;
  channel_type?: string;
}

const NOT_AUTHORIZED = 'You are not authorized to use this bot.';

export function createSlackApp(deps: { runAgent: () => AgentRunner }): { app: App; port: SlackPort } {
  const cfg = getConfig();
  const app = new App({
    token: cfg.SLACK_BOT_TOKEN,
    appToken: cfg.SLACK_APP_TOKEN,
    socketMode: true,
    logLevel: LogLevel.WARN, // ignoreSelf stays at Bolt's default (A15)
  });
  const client = app.client;
  const firstTime = createEventDeduper();

  // ── SlackPort ──
  async function postChunks(channel: string, text: string, threadTs?: string): Promise<{ ts: string }> {
    const chunks = formatForSlack(text);
    if (chunks.length === 0) chunks.push(' ');
    let firstTs = '';
    for (const chunk of chunks) {
      const res = await client.chat.postMessage({
        channel,
        text: chunk,
        // A16: Slack's markdown block renders the model's Markdown natively.
        blocks: [{ type: 'markdown', text: chunk }],
        ...(threadTs !== undefined ? { thread_ts: threadTs } : {}),
      });
      if (!firstTs) firstTs = String(res.ts ?? '');
    }
    return { ts: firstTs };
  }

  const port: SlackPort = {
    postMessage: (channel, text, threadTs) => postChunks(channel, text, threadTs),

    async uploadFile(channel, threadTs, filePath, title) {
      // Only files inside the sandbox workspace may be uploaded (a model-supplied path must not leak agent.db).
      const workspace = fs.realpathSync(dataPaths().workspace);
      const real = fs.realpathSync(path.resolve(dataPaths().workspace, filePath));
      if (real !== workspace && !real.startsWith(workspace + path.sep)) {
        throw new Error('uploadFile: path is outside the workspace');
      }
      await client.files.uploadV2({
        channel_id: channel,
        thread_ts: threadTs,
        file: fs.readFileSync(real),
        filename: path.basename(real),
        title: title ?? path.basename(real),
      });
    },

    async postApprovalRequest(req) {
      const res = await client.chat.postMessage({
        channel: req.channelId,
        thread_ts: req.threadTs,
        text: `Approval needed: ${req.toolName}`,
        blocks: approvalBlocks(req),
      });
      if (res.ts) setApprovalMessageTs(req.id, String(res.ts));
    },
  };

  // ── Reactions (A17); failures never break a turn ──
  const react = {
    async add(channel: string, ts: string, name: string) {
      try {
        await client.reactions.add({ channel, timestamp: ts, name });
      } catch {
        /* already reacted or missing scope */
      }
    },
    async remove(channel: string, ts: string, name: string) {
      try {
        await client.reactions.remove({ channel, timestamp: ts, name });
      } catch {
        /* not present */
      }
    },
  };

  async function postError(channel: string, threadTs: string, err: unknown) {
    console.error('[slack] turn failed:', safeErrorLine(err));
    try {
      await client.chat.postMessage({ channel, text: safeErrorLine(err), thread_ts: threadTs }); // plain text: one line
    } catch (e) {
      console.error('[slack] could not post error line:', e instanceof Error ? e.message : e);
    }
  }

  /** A17 + A16: run one agent turn for a user message and post the reply. */
  async function handleTurn(t: {
    channel: string;
    threadTs: string;
    eventTs: string;
    userId: string;
    text: string;
  }): Promise<void> {
    await react.add(t.channel, t.eventTs, 'hourglass_flowing_sand');
    try {
      const result = await deps.runAgent()({
        threadTs: t.threadTs,
        channelId: t.channel,
        userId: t.userId,
        userMessage: t.text,
      });
      // The runner posts approval requests itself; only the text is ours.
      if (result.text.trim() !== '') await postChunks(t.channel, result.text, t.threadTs);
      await react.remove(t.channel, t.eventTs, 'hourglass_flowing_sand');
      await react.add(t.channel, t.eventTs, 'white_check_mark');
    } catch (err) {
      await react.remove(t.channel, t.eventTs, 'hourglass_flowing_sand');
      await react.add(t.channel, t.eventTs, 'x');
      await postError(t.channel, t.threadTs, err);
    }
  }

  const stripMention = (text: string, botUserId?: string) =>
    (botUserId ? text.split(`<@${botUserId}>`).join('') : text).trim();

  // ── Events ──
  app.event('app_mention', async ({ event, context }) => {
    const ev = event as unknown as MessageEventLike;
    if (!isAllowedUser(ev.user)) return; // A07 first
    if (!ev.channel || !ev.ts || typeof ev.text !== 'string') return;
    if (!firstTime(`${ev.channel}:${ev.ts}`)) return; // A15
    const text = stripMention(ev.text, context.botUserId);
    if (text === '') return;
    const threadTs = ev.thread_ts ?? ev.ts;
    ensureThread({ threadTs, channelId: ev.channel });
    void handleTurn({ channel: ev.channel, threadTs, eventTs: ev.ts, userId: ev.user!, text });
  });

  app.event('message', async ({ event, context }) => {
    const ev = event as unknown as MessageEventLike;
    if (!isAllowedUser(ev.user)) return; // A07 first
    if (ev.subtype || ev.bot_id) return; // A15: edits, deletes, bot messages
    if (!ev.channel || !ev.ts || typeof ev.text !== 'string') return;
    const isDm = ev.channel_type === 'im';
    const threadTs = ev.thread_ts ?? ev.ts;
    if (!isDm) {
      // Channel messages count only as replies in a thread the agent already owns;
      // a fresh @mention arrives via app_mention.
      if (!ev.thread_ts || !getThread(ev.thread_ts)) return;
    }
    if (!firstTime(`${ev.channel}:${ev.ts}`)) return; // A15
    const text = stripMention(ev.text, context.botUserId);
    if (text === '') return;
    ensureThread({ threadTs, channelId: ev.channel });
    void handleTurn({ channel: ev.channel, threadTs, eventTs: ev.ts, userId: ev.user!, text });
  });

  // ── /model ──
  app.command('/model', async ({ command, ack, respond }) => {
    await ack(); // within Slack's 3 seconds
    if (!isAllowedUser(command.user_id)) return; // A07
    const arg = (command.text ?? '').trim();
    try {
      if (arg === '') {
        const active = getGlobalModel() ?? getConfig().DEFAULT_MODEL;
        const models = listAvailableModels().map((m) => `\`${m}\``).join(', ') || '(none configured)';
        await respond({ response_type: 'ephemeral', text: `Active model: \`${active}\`\nAvailable: ${models}` });
        return;
      }
      const check = validateModelId(arg);
      if (!check.ok) {
        await respond({ response_type: 'ephemeral', text: `Not switched: ${check.reason}` });
        return;
      }
      setGlobalModel(arg);
      await respond({ response_type: 'ephemeral', text: `Active model is now \`${arg}\`.` });
    } catch (err) {
      console.error('[slack] /model failed:', err instanceof Error ? err.message : err);
    }
  });

  // ── Approval buttons (A13) ──
  app.action(/^(approve|reject)_tool_.+$/, async ({ ack, body, action }) => {
    await ack(); // immediately
    const b = body as unknown as {
      user?: { id?: string };
      channel?: { id?: string };
      container?: { channel_id?: string; message_ts?: string };
      message?: { ts?: string };
    };
    const userId = b.user?.id ?? '';
    const actionId = String((action as { action_id?: string }).action_id ?? '');
    const m = /^(approve|reject)_tool_(.+)$/.exec(actionId);
    if (!m) return;
    const approved = m[1] === 'approve';
    const id = m[2]!;
    const chan = b.channel?.id ?? b.container?.channel_id;

    if (!isAllowedUser(userId)) {
      // A07: ephemeral refusal, nothing changes
      if (chan) {
        await client.chat
          .postEphemeral({ channel: chan, user: userId, text: NOT_AUTHORIZED })
          .catch(() => undefined);
      }
      return;
    }

    const row = getApproval(id);
    if (!row) return;
    if (!resolveApproval(id, approved, userId)) {
      if (chan) {
        await client.chat
          .postEphemeral({ channel: chan, user: userId, text: 'This approval was already decided or has expired.' })
          .catch(() => undefined);
      }
      return;
    }

    const messageTs = row.messageTs ?? b.container?.message_ts ?? b.message?.ts;
    if (messageTs) {
      try {
        await client.chat.update({
          channel: row.channelId,
          ts: messageTs,
          text: `${approved ? 'Approved' : 'Rejected'} ${row.toolName} by <@${userId}>`,
          blocks: decidedBlocks({
            toolName: row.toolName,
            argsPreview: previewArgs(row.toolArgs),
            verdict: approved ? 'Approved' : 'Rejected',
            userId,
            at: Date.now(),
          }),
        });
      } catch (err) {
        console.error('[slack] could not update approval message:', err instanceof Error ? err.message : err);
      }
    }

    // Resume the turn (the runner takes the thread lock itself).
    try {
      const result = await deps.runAgent()({
        threadTs: row.threadTs,
        channelId: row.channelId,
        userId,
        approvalResponse: { approvalId: row.approvalId, approved },
      });
      if (result.text.trim() !== '') await postChunks(row.channelId, result.text, row.threadTs);
    } catch (err) {
      await postError(row.channelId, row.threadTs, err);
    }
  });

  app.error(async (err) => {
    console.error('[slack] unhandled error:', err instanceof Error ? err.message : err);
  });

  return { app, port };
}
