/**
 * slack.ts: pure helpers (A07, A15, A16) and the Bolt app driven through
 * app.processEvent with a faked Web API (A07, A13, A15, A16, A17).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetConfigCache } from '../src/config.js';
import {
  createApproval,
  ensureThread,
  getApproval,
  getGlobalModel,
  getThread,
  setApprovalMessageTs,
} from '../src/db.js';
import type { AgentTurnInput } from '../src/types.js';
import { ALLOWED_USER, OTHER_USER, applyEnv, setupTestEnv, sleep, type TestEnv } from './helpers/env.js';
import { fakeRunner } from './helpers/fakes.js';
import { loadSrc, type SlackModule } from './helpers/modules.js';
import {
  BOT_USER_ID,
  blockActionBody,
  commandBody,
  dispatch,
  eventBody,
  installFakeWebApi,
  startResponseUrlServer,
  visibleText,
  type FakeWebApi,
  type ResponseUrlServer,
} from './helpers/slack-harness.js';

applyEnv();
const slack = await loadSrc<SlackModule>('slack.js');

let env: TestEnv;
beforeEach(async () => {
  env = await setupTestEnv({ env: { OPENAI_API_KEY: 'test-openai', SLACK_DEFAULT_CHANNEL: 'C0DEFAULT' } });
});
afterEach(async () => {
  await env.cleanup();
});

// ─── Pure helpers ──────────────────────────────────────────────────────────

describe.skipIf(!slack)('isAllowedUser (A07)', () => {
  it('allows only listed users', () => {
    expect(slack!.isAllowedUser(ALLOWED_USER)).toBe(true);
    expect(slack!.isAllowedUser(OTHER_USER)).toBe(false);
    expect(slack!.isAllowedUser('')).toBe(false);
    expect(slack!.isAllowedUser(ALLOWED_USER.toLowerCase())).toBe(false);
    expect(slack!.isAllowedUser(` ${ALLOWED_USER}`)).toBe(false);
    expect(slack!.isAllowedUser('__proto__')).toBe(false);
    expect(slack!.isAllowedUser('constructor')).toBe(false);
  });

  it('reads ALLOWED_SLACK_USER_IDS at call time', () => {
    process.env.ALLOWED_SLACK_USER_IDS = 'U0NEWUSER';
    resetConfigCache();
    expect(slack!.isAllowedUser('U0NEWUSER')).toBe(true);
    expect(slack!.isAllowedUser(ALLOWED_USER)).toBe(false);
  });
});

describe.skipIf(!slack)('createEventDeduper (A15)', () => {
  it('returns true the first time a key is seen, false after', () => {
    const seen = slack!.createEventDeduper();
    expect(seen('C1:1700000000.000100')).toBe(true);
    expect(seen('C1:1700000000.000100')).toBe(false);
    expect(seen('C1:1700000000.000200')).toBe(true);
    expect(seen('C2:1700000000.000100')).toBe(true);
  });

  it('separate dedupers do not share state', () => {
    const a = slack!.createEventDeduper();
    const b = slack!.createEventDeduper();
    expect(a('k')).toBe(true);
    expect(b('k')).toBe(true);
  });

  it('is bounded: very old keys are eventually evicted', () => {
    const seen = slack!.createEventDeduper();
    seen('first');
    for (let i = 0; i < 200_000; i++) seen(`k${i}`);
    expect(seen('first')).toBe(true);
    // ...while a recent key is still remembered
    expect(seen('k199999')).toBe(false);
  });
});

describe.skipIf(!slack)('splitForSlack (A16)', () => {
  const nonWs = (s: string) => s.replace(/\s+/g, '');

  it('keeps short text in one chunk', () => {
    expect(slack!.splitForSlack('hello world')).toEqual(['hello world']);
  });

  it('splits a 10k-char reply into several chunks, none over the default limit (~3500)', () => {
    const para = 'The quick brown fox jumps over the lazy dog. '.repeat(20);
    const text = Array.from({ length: 12 }, (_, i) => `Paragraph ${i}: ${para}`).join('\n\n');
    expect(text.length).toBeGreaterThan(10_000);
    const chunks = slack!.splitForSlack(text);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(3_500);
      expect(c.trim().length).toBeGreaterThan(0);
    }
    expect(nonWs(chunks.join(''))).toBe(nonWs(text));
  });

  it('hard-splits text with no whitespace at all', () => {
    const text = 'x'.repeat(10_000);
    const chunks = slack!.splitForSlack(text, 3_000);
    expect(chunks.length).toBeGreaterThanOrEqual(4);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(3_000);
    expect(chunks.join('')).toBe(text);
  });

  it('honours a custom limit and loses no characters across many shapes', () => {
    const shapes = [
      'word '.repeat(3_000),
      'line\n'.repeat(3_000),
      '```\n' + 'code line\n'.repeat(1_500) + '```',
      'emoji 🎉🎉 '.repeat(1_200),
    ];
    for (const text of shapes) {
      const chunks = slack!.splitForSlack(text, 1_000);
      for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1_000);
      expect(nonWs(chunks.join(''))).toBe(nonWs(text));
    }
  });
});

// ─── Bolt app ──────────────────────────────────────────────────────────────

const canRunApp = Boolean(slack?.createSlackApp);
const DM = 'D0DMCHAN1';
const CHAN = 'C0CHAN';

interface Harness {
  api: FakeWebApi;
  respond: ResponseUrlServer;
  runner: ReturnType<typeof fakeRunner>;
  app: NonNullable<ReturnType<NonNullable<SlackModule['createSlackApp']>>>['app'];
}

let tsSeq = 0;
const nextTs = () => `1750000000.${String(++tsSeq).padStart(6, '0')}`;

async function makeApp(impl?: Parameters<typeof fakeRunner>[0]): Promise<Harness> {
  const api = installFakeWebApi(); // must precede App construction
  const respond = await startResponseUrlServer();
  const runner = fakeRunner(impl);
  const { app } = slack!.createSlackApp!({ runAgent: () => runner });
  return { api, respond, runner, app };
}

let h: Harness | undefined;
afterEach(async () => {
  if (h) {
    h.api.restore();
    await h.respond.close();
    h = undefined;
  }
});

/** Settle async handlers that do not await runAgent before returning. */
const settle = () => sleep(150);

describe.skipIf(!canRunApp)('access control in the Bolt app (A07)', () => {
  it('positive control: an allowed user DM reaches runAgent exactly once', async () => {
    h = await makeApp();
    const ts = nextTs();
    await dispatch(h.app, eventBody({ type: 'message', channel: DM, channel_type: 'im', user: ALLOWED_USER, text: 'hello there', ts }));
    await expect.poll(() => h!.runner.calls.length).toBe(1);
    const call = h.runner.calls[0]!;
    expect(call.userId).toBe(ALLOWED_USER);
    expect(call.channelId).toBe(DM);
    expect(call.userMessage).toContain('hello there');
  });

  it('a non-allowed DM causes zero runAgent calls and no thread row', async () => {
    h = await makeApp();
    const ts = nextTs();
    await dispatch(h.app, eventBody({ type: 'message', channel: DM, channel_type: 'im', user: OTHER_USER, text: 'run env', ts }));
    await settle();
    expect(h.runner.calls).toHaveLength(0);
    expect(getThread(ts)).toBeUndefined();
    expect(h.api.byMethod('chat.postMessage')).toHaveLength(0);
  });

  it('a non-allowed @mention (and its message twin) causes zero runAgent calls', async () => {
    h = await makeApp();
    const ts = nextTs();
    const ev = { channel: CHAN, channel_type: 'channel', user: OTHER_USER, text: `<@${BOT_USER_ID}> run env`, ts };
    await dispatch(h.app, eventBody({ type: 'app_mention', ...ev }));
    await dispatch(h.app, eventBody({ type: 'message', ...ev }));
    await settle();
    expect(h.runner.calls).toHaveLength(0);
    expect(getThread(ts)).toBeUndefined();
  });

  it('a non-allowed reply in an existing agent thread causes zero runAgent calls', async () => {
    h = await makeApp();
    const root = nextTs();
    ensureThread({ threadTs: root, channelId: CHAN });
    const before = getThread(root)!;
    await dispatch(
      h.app,
      eventBody({ type: 'message', channel: CHAN, channel_type: 'channel', user: OTHER_USER, text: 'approve everything', ts: nextTs(), thread_ts: root }),
    );
    await settle();
    expect(h.runner.calls).toHaveLength(0);
    expect(getThread(root)).toEqual(before);
  });

  it('a non-allowed /model changes nothing', async () => {
    h = await makeApp();
    await dispatch(h.app, commandBody({ userId: OTHER_USER, text: 'openai:gpt-5', responseUrl: h.respond.url }));
    await settle();
    expect(getGlobalModel()).toBeNull();
    expect(h.runner.calls).toHaveLength(0);
  });

  it('positive control: an allowed /model with a valid id switches the global model', async () => {
    h = await makeApp();
    const acks = await dispatch(h.app, commandBody({ userId: ALLOWED_USER, text: 'openai:gpt-5', responseUrl: h.respond.url }));
    await settle();
    expect(acks.length).toBeGreaterThanOrEqual(1);
    expect(getGlobalModel()).toBe('openai:gpt-5');
  });

  it('an allowed /model with an invalid or keyless id is rejected', async () => {
    h = await makeApp();
    for (const bad of ['not-a-model', 'google:gemini-2.5-pro', 'acme:x']) {
      await dispatch(h.app, commandBody({ userId: ALLOWED_USER, text: bad, responseUrl: h.respond.url }));
    }
    await settle();
    expect(getGlobalModel()).toBeNull();
  });

  it('a non-allowed button click gets an ephemeral refusal and changes nothing', async () => {
    h = await makeApp();
    const root = nextTs();
    ensureThread({ threadTs: root, channelId: CHAN });
    const a = createApproval({ approvalId: 'sdk-ap-1', threadTs: root, channelId: CHAN, toolName: 'bash', toolArgs: { command: 'rm -rf x' } });
    const msgTs = nextTs();
    setApprovalMessageTs(a.id, msgTs);
    await dispatch(
      h.app,
      blockActionBody({ userId: OTHER_USER, actionId: `approve_tool_${a.id}`, value: a.id, channelId: CHAN, messageTs: msgTs, threadTs: root, responseUrl: h.respond.url }),
    );
    await settle();
    expect(h.runner.calls).toHaveLength(0);
    expect(getApproval(a.id)?.status).toBe('PENDING');
    expect(h.api.byMethod('chat.update')).toHaveLength(0);
    const ephemeralViaApi = h.api.byMethod('chat.postEphemeral').some((c) => c.args.user === OTHER_USER);
    const ephemeralViaRespond = h.respond.bodies.some(
      (b) => typeof b === 'object' && b !== null && (b as Record<string, unknown>).response_type !== 'in_channel' && (b as Record<string, unknown>).replace_original !== true,
    );
    expect(ephemeralViaApi || ephemeralViaRespond, 'ephemeral "not authorized" notice').toBe(true);
  });
});

describe.skipIf(!canRunApp)('approval buttons (A13)', () => {
  async function pendingApproval(createdAt?: number) {
    const root = nextTs();
    ensureThread({ threadTs: root, channelId: CHAN });
    const a = createApproval({
      approvalId: `sdk-${root}`,
      threadTs: root,
      channelId: CHAN,
      toolName: 'bash',
      toolArgs: { command: 'rm -rf build' },
      requestedBy: ALLOWED_USER,
      ...(createdAt !== undefined ? { createdAt } : {}),
    });
    const msgTs = nextTs();
    setApprovalMessageTs(a.id, msgTs);
    return { root, a, msgTs };
  }
  const click = (verb: 'approve' | 'reject', id: string, root: string, msgTs: string, user = ALLOWED_USER) =>
    dispatch(
      h!.app,
      blockActionBody({ userId: user, actionId: `${verb}_tool_${id}`, value: id, channelId: CHAN, messageTs: msgTs, threadTs: root, responseUrl: h!.respond.url }),
    );

  it('approve: acks, resolves, updates the message with who decided, and resumes the turn once', async () => {
    h = await makeApp();
    const { root, a, msgTs } = await pendingApproval();
    const acks = await click('approve', a.id, root, msgTs);
    expect(acks.length).toBe(1);
    await expect.poll(() => h!.runner.calls.length).toBe(1);
    const call = h.runner.calls[0]!;
    expect(call.threadTs).toBe(root);
    expect(call.approvalResponse).toMatchObject({ approvalId: a.approvalId, approved: true });
    const row = getApproval(a.id)!;
    expect(row.status).toBe('APPROVED');
    expect(row.decidedBy).toBe(ALLOWED_USER);
    const updates = h.api.byMethod('chat.update');
    expect(updates.length).toBeGreaterThanOrEqual(1);
    expect(updates.some((u) => visibleText(u.args).includes(ALLOWED_USER))).toBe(true);
  });

  it('double click: the second approve does not resume the turn again', async () => {
    h = await makeApp();
    const { root, a, msgTs } = await pendingApproval();
    await Promise.all([click('approve', a.id, root, msgTs), click('approve', a.id, root, msgTs)]);
    await click('approve', a.id, root, msgTs);
    await settle();
    expect(h.runner.calls.filter((c) => c.approvalResponse)).toHaveLength(1);
  });

  it('reject: resumes with approved=false, exactly once, and never approves later', async () => {
    h = await makeApp();
    const { root, a, msgTs } = await pendingApproval();
    await click('reject', a.id, root, msgTs);
    await expect.poll(() => h!.runner.calls.length).toBe(1);
    expect(h.runner.calls[0]!.approvalResponse).toMatchObject({ approvalId: a.approvalId, approved: false });
    await click('approve', a.id, root, msgTs);
    await settle();
    expect(h.runner.calls).toHaveLength(1);
    expect(getApproval(a.id)?.status).toBe('REJECTED');
  });

  it('an expired approval cannot be approved', async () => {
    h = await makeApp();
    const { root, a, msgTs } = await pendingApproval(Date.now() - 25 * 60 * 60 * 1000);
    await click('approve', a.id, root, msgTs);
    await settle();
    expect(h.runner.calls).toHaveLength(0);
    expect(getApproval(a.id)?.status).not.toBe('APPROVED');
  });

  it('an unknown approval id is harmless', async () => {
    h = await makeApp();
    await click('approve', 'no-such-id', nextTs(), nextTs());
    await settle();
    expect(h.runner.calls).toHaveLength(0);
  });
});

describe.skipIf(!canRunApp)('event dedupe and filtering (A15)', () => {
  it('the same @mention via app_mention and message → one runAgent call', async () => {
    h = await makeApp();
    const root = nextTs();
    ensureThread({ threadTs: root, channelId: CHAN });
    const ts = nextTs();
    const ev = { channel: CHAN, channel_type: 'channel', user: ALLOWED_USER, text: `<@${BOT_USER_ID}> status?`, ts, thread_ts: root };
    await dispatch(h.app, eventBody({ type: 'app_mention', ...ev }));
    await dispatch(h.app, eventBody({ type: 'message', ...ev }));
    await settle();
    await expect.poll(() => h!.runner.calls.length).toBe(1);
    await settle();
    expect(h.runner.calls).toHaveLength(1);
  });

  it('a top-level channel @mention via both events → one runAgent call', async () => {
    h = await makeApp();
    const ts = nextTs();
    const ev = { channel: CHAN, channel_type: 'channel', user: ALLOWED_USER, text: `<@${BOT_USER_ID}> hi`, ts };
    await dispatch(h.app, eventBody({ type: 'message', ...ev }));
    await dispatch(h.app, eventBody({ type: 'app_mention', ...ev }));
    await expect.poll(() => h!.runner.calls.length).toBe(1);
    await settle();
    expect(h.runner.calls).toHaveLength(1);
  });

  it('Slack retries of the same event are processed once', async () => {
    h = await makeApp();
    const ts = nextTs();
    const body = eventBody({ type: 'message', channel: DM, channel_type: 'im', user: ALLOWED_USER, text: 'once', ts });
    await dispatch(h.app, body);
    await dispatch(h.app, body);
    await settle();
    await expect.poll(() => h!.runner.calls.length).toBe(1);
  });

  it('message subtypes (edits, deletes, bot messages) are ignored', async () => {
    h = await makeApp();
    const base = { channel: DM, channel_type: 'im' };
    await dispatch(h.app, eventBody({ type: 'message', subtype: 'message_changed', ...base, ts: nextTs(), message: { user: ALLOWED_USER, text: 'edited', ts: nextTs() } }));
    await dispatch(h.app, eventBody({ type: 'message', subtype: 'message_deleted', ...base, ts: nextTs(), previous_message: { user: ALLOWED_USER, text: 'x' } }));
    await dispatch(h.app, eventBody({ type: 'message', subtype: 'bot_message', ...base, ts: nextTs(), bot_id: 'B0OTHER', text: 'beep' }));
    await settle();
    expect(h.runner.calls).toHaveLength(0);
  });

  it('a message with an unexpected shape does not throw out of processEvent', async () => {
    h = await makeApp();
    await expect(dispatch(h.app, eventBody({ type: 'message', channel: DM, channel_type: 'im', user: ALLOWED_USER, ts: nextTs() }))).resolves.toBeDefined();
    await expect(dispatch(h.app, eventBody({ type: 'message', channel: DM, channel_type: 'im', ts: nextTs(), text: 'no user' }))).resolves.toBeDefined();
  });
});

describe.skipIf(!canRunApp)('replies (A16) and reactions (A17)', () => {
  const longReply = Array.from({ length: 14 }, (_, i) => `Section ${i}: ${'lorem ipsum dolor sit amet '.repeat(28)}`).join('\n\n');

  it('a 10k-char reply is posted as several thread messages, none over the limit', async () => {
    expect(longReply.length).toBeGreaterThan(10_000);
    h = await makeApp(() => ({ text: longReply, modelId: 'mock:m', pendingApprovals: [] }));
    const ts = nextTs();
    await dispatch(h.app, eventBody({ type: 'message', channel: DM, channel_type: 'im', user: ALLOWED_USER, text: 'write a lot', ts }));
    await expect.poll(() => h!.runner.calls.length).toBe(1);
    await expect.poll(() => h!.api.byMethod('chat.postMessage').length).toBeGreaterThanOrEqual(3);
    const posts = h.api.byMethod('chat.postMessage');
    for (const p of posts) {
      expect(p.args.thread_ts).toBe(ts);
      expect(String(p.args.text ?? '').length).toBeLessThanOrEqual(4_000);
    }
    const all = posts.map((p) => visibleText(p.args)).join('');
    expect(all.replace(/\W+/g, '')).toContain('Section13');
  });

  it('adds the hourglass, then swaps it for a check mark on success', async () => {
    h = await makeApp();
    const ts = nextTs();
    await dispatch(h.app, eventBody({ type: 'message', channel: DM, channel_type: 'im', user: ALLOWED_USER, text: 'hi', ts }));
    await expect.poll(() => h!.api.byMethod('reactions.add').some((c) => c.args.name === 'white_check_mark')).toBe(true);
    const adds = h.api.byMethod('reactions.add').map((c) => c.args.name);
    expect(adds[0]).toBe('hourglass_flowing_sand');
    expect(h.api.byMethod('reactions.remove').some((c) => c.args.name === 'hourglass_flowing_sand')).toBe(true);
    for (const c of h.api.byMethod('reactions.add')) expect(c.args.timestamp).toBe(ts);
  });

  it('on runner error: adds :x:, posts a one-line error, and does not crash', async () => {
    h = await makeApp(() => {
      throw new Error('provider exploded: sk-ant-SECRET-should-not-leak');
    });
    const ts = nextTs();
    await dispatch(h.app, eventBody({ type: 'message', channel: DM, channel_type: 'im', user: ALLOWED_USER, text: 'hi', ts }));
    await expect.poll(() => h!.api.byMethod('reactions.add').some((c) => c.args.name === 'x')).toBe(true);
    const errPosts = h.api.byMethod('chat.postMessage').filter((p) => p.args.thread_ts === ts);
    expect(errPosts.length).toBeGreaterThanOrEqual(1);
    const text = visibleText(errPosts.at(-1)!.args);
    expect(text.trim().split('\n').length).toBe(1);
  });

  it('(reviewer) the posted error does not echo key-like strings from the provider error', async () => {
    h = await makeApp(() => {
      throw new Error('401 Incorrect API key provided: sk-ant-api03-SECRETSECRETSECRET');
    });
    const ts = nextTs();
    await dispatch(h.app, eventBody({ type: 'message', channel: DM, channel_type: 'im', user: ALLOWED_USER, text: 'hi', ts }));
    await expect.poll(() => h!.api.byMethod('reactions.add').some((c) => c.args.name === 'x')).toBe(true);
    const posted = h.api.byMethod('chat.postMessage').map((p) => visibleText(p.args)).join('\n');
    expect(posted).not.toContain('SECRETSECRETSECRET');
  });
});

describe.skipIf(!canRunApp)('runAgent input shape', () => {
  it('passes thread ts for replies and never forwards another user id', async () => {
    h = await makeApp();
    const root = nextTs();
    ensureThread({ threadTs: root, channelId: CHAN });
    await dispatch(
      h.app,
      eventBody({ type: 'message', channel: CHAN, channel_type: 'channel', user: ALLOWED_USER, text: 'follow up', ts: nextTs(), thread_ts: root }),
    );
    await expect.poll(() => h!.runner.calls.length).toBe(1);
    const call: AgentTurnInput = h.runner.calls[0]!;
    expect(call.threadTs).toBe(root);
    expect(call.channelId).toBe(CHAN);
    expect(call.userId).toBe(ALLOWED_USER);
  });
});

if (!(slack)) describe('slack.ts not written yet (Wave 2)', () => {
  it.todo('A07 isAllowedUser + Bolt access control');
  it.todo('A13 approval buttons');
  it.todo('A15 dedupe, A16 split, A17 reactions');
});
