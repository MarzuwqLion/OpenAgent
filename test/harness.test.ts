/**
 * Self-tests for the test harness, against the real installed libraries, so a
 * Wave 2 failure in slack/scheduler/agent tests means the code is wrong, not
 * the harness: Bolt processEvent + faked Web API + response_url server, and
 * the recording croner wrapper.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, LogLevel } from '@slack/bolt';
import { Cron } from 'croner';
import {
  blockActionBody,
  commandBody,
  dispatch,
  eventBody,
  installFakeWebApi,
  startResponseUrlServer,
  type FakeWebApi,
  type ResponseUrlServer,
} from './helpers/slack-harness.js';
import { FakeSchedulerPort, FakeSlackPort, fakeRunner } from './helpers/fakes.js';

const rec = vi.hoisted(() => ({ jobs: [] as { options: unknown }[] }));
vi.mock('croner', async (importOriginal) => {
  const real = await importOriginal<typeof import('croner')>();
  class RecordingCron extends real.Cron {
    constructor(pattern: string | Date, a?: unknown, b?: unknown) {
      super(pattern, a as never, b as never);
      rec.jobs.push({ options: [a, b].find((x) => x !== null && typeof x === 'object') });
    }
  }
  return { ...real, Cron: RecordingCron };
});

let api: FakeWebApi | undefined;
let server: ResponseUrlServer | undefined;
afterEach(async () => {
  api?.restore();
  await server?.close();
  api = undefined;
  server = undefined;
});

function makeApp(): App {
  return new App({ token: 'xoxb-test', appToken: 'xapp-test', socketMode: true, logLevel: LogLevel.ERROR });
}

describe('Bolt harness', () => {
  it('routes a DM through processEvent and records Web API calls', async () => {
    api = installFakeWebApi();
    const app = makeApp();
    const seen: string[] = [];
    app.message(async ({ message, client }) => {
      if (!('user' in message) || !('text' in message)) return;
      seen.push(`${message.user}:${message.text}`);
      await client.reactions.add({ channel: message.channel, timestamp: message.ts, name: 'hourglass_flowing_sand' });
      await client.chat.postMessage({ channel: message.channel, thread_ts: message.ts, text: 'reply' });
    });
    await dispatch(app, eventBody({ type: 'message', channel: 'D1', channel_type: 'im', user: 'U0ALLOWED1', text: 'hi', ts: '1.000001' }));
    expect(seen).toEqual(['U0ALLOWED1:hi']);
    expect(api.byMethod('auth.test').length).toBeGreaterThanOrEqual(1);
    expect(api.byMethod('reactions.add')[0]?.args).toMatchObject({ name: 'hourglass_flowing_sand', timestamp: '1.000001' });
    expect(api.byMethod('chat.postMessage')[0]?.args).toMatchObject({ thread_ts: '1.000001', text: 'reply' });
  });

  it('routes app_mention events', async () => {
    api = installFakeWebApi();
    const app = makeApp();
    let mentions = 0;
    app.event('app_mention', async () => {
      mentions += 1;
    });
    await dispatch(app, eventBody({ type: 'app_mention', channel: 'C1', user: 'U0ALLOWED1', text: '<@UBOT00001> hi', ts: '1.000002' }));
    expect(mentions).toBe(1);
  });

  it('routes block actions by action_id regex and acks', async () => {
    api = installFakeWebApi();
    server = await startResponseUrlServer();
    const app = makeApp();
    const clicks: string[] = [];
    app.action(/^approve_tool_(.+)$/, async ({ ack, body, action }) => {
      await ack();
      clicks.push(`${body.user.id}:${'action_id' in action ? action.action_id : ''}`);
    });
    const acks = await dispatch(
      app,
      blockActionBody({ userId: 'U0EVIL999', actionId: 'approve_tool_abc', value: 'abc', channelId: 'C1', messageTs: '1.1', responseUrl: server.url }),
    );
    expect(clicks).toEqual(['U0EVIL999:approve_tool_abc']);
    expect(acks).toHaveLength(1);
  });

  it('routes slash commands; respond() reaches the local response_url server', async () => {
    api = installFakeWebApi();
    server = await startResponseUrlServer();
    const app = makeApp();
    app.command('/model', async ({ ack, respond, command }) => {
      await ack();
      await respond({ response_type: 'ephemeral', text: `got ${command.text}` });
    });
    const acks = await dispatch(app, commandBody({ userId: 'U0ALLOWED1', text: 'openai:gpt-5', responseUrl: server.url }));
    expect(acks).toHaveLength(1);
    expect(server.bodies).toEqual([expect.objectContaining({ text: 'got openai:gpt-5' })]);
  });
});

describe('croner recording wrapper', () => {
  it('records options and keeps real Cron behaviour', () => {
    rec.jobs.length = 0;
    const job = new Cron('0 8 * * *', { timezone: 'America/New_York', protect: true }, () => undefined);
    expect(rec.jobs).toHaveLength(1);
    expect(rec.jobs[0]?.options).toMatchObject({ timezone: 'America/New_York', protect: true });
    expect(job.isRunning()).toBe(true);
    job.stop();
    expect(job.isRunning()).toBe(false);
  });
});

describe('fakes', () => {
  it('FakeSlackPort returns increasing ts and records calls', async () => {
    const s = new FakeSlackPort();
    const a = await s.postMessage('C1', 'one');
    const b = await s.postMessage('C1', 'two', a.ts);
    expect(b.ts > a.ts).toBe(true);
    expect(s.messages[1]).toMatchObject({ threadTs: a.ts, text: 'two' });
  });

  it('FakeSchedulerPort and fakeRunner record calls', async () => {
    const sch = new FakeSchedulerPort();
    await sch.reloadSchedules();
    expect(await sch.scheduleFollowup({ threadTs: 't', channelId: 'C', runAt: 1, prompt: 'p' })).toBe('fu-1');
    expect(sch.reloads).toBe(1);
    const r = fakeRunner();
    await r({ threadTs: 't', channelId: 'C', userId: 'U' });
    expect(r.calls).toHaveLength(1);
  });
});
