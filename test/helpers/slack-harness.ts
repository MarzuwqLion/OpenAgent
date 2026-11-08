/**
 * Drives a Bolt App without a socket: Web API calls are intercepted at
 * WebClient.prototype.apiCall (install BEFORE constructing the App, because
 * WebClient binds apiCall per instance at construction), and events are fed
 * through `app.processEvent`. A local HTTP server stands in for response_url.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { vi } from 'vitest';
import { webApi, type App } from '@slack/bolt';

export const BOT_USER_ID = 'UBOT00001';
export const BOT_ID = 'BBOT00001';

export interface ApiCall {
  method: string;
  args: Record<string, unknown>;
}

export interface FakeWebApi {
  calls: ApiCall[];
  byMethod(method: string): ApiCall[];
  restore(): void;
}

export function installFakeWebApi(): FakeWebApi {
  const calls: ApiCall[] = [];
  let seq = 0;
  const spy = vi
    .spyOn(webApi.WebClient.prototype, 'apiCall')
    .mockImplementation(async (method: string, options?: Record<string, unknown>) => {
      calls.push({ method, args: options ?? {} });
      seq += 1;
      switch (method) {
        case 'auth.test':
          return { ok: true, user_id: BOT_USER_ID, bot_id: BOT_ID, team_id: 'T0TEAM', user: 'openagent' };
        case 'chat.postMessage':
        case 'chat.postEphemeral':
          return {
            ok: true,
            ts: `1800000000.${String(seq).padStart(6, '0')}`,
            message_ts: `1800000000.${String(seq).padStart(6, '0')}`,
            channel: options?.channel,
          };
        case 'users.info':
          return { ok: true, user: { id: options?.user, tz: 'UTC', name: 'someone' } };
        default:
          return { ok: true };
      }
    });
  return {
    calls,
    byMethod: (m) => calls.filter((c) => c.method === m),
    restore: () => spy.mockRestore(),
  };
}

let eventSeq = 0;

export function eventBody(event: Record<string, unknown>): Record<string, unknown> {
  eventSeq += 1;
  return {
    token: 'verification-token',
    team_id: 'T0TEAM',
    api_app_id: 'A0APP',
    type: 'event_callback',
    event_id: `Ev${String(eventSeq).padStart(8, '0')}`,
    event_time: Math.floor(Date.now() / 1000),
    authorizations: [{ team_id: 'T0TEAM', user_id: BOT_USER_ID, is_bot: true }],
    event: { event_ts: event.ts, ...event },
  };
}

export function commandBody(o: { userId: string; text: string; command?: string; channelId?: string; responseUrl: string }) {
  return {
    token: 'verification-token',
    team_id: 'T0TEAM',
    team_domain: 'test',
    channel_id: o.channelId ?? 'C0CHAN',
    channel_name: 'general',
    user_id: o.userId,
    user_name: 'someone',
    command: o.command ?? '/model',
    text: o.text,
    api_app_id: 'A0APP',
    response_url: o.responseUrl,
    trigger_id: 'trigger.1',
  };
}

export function blockActionBody(o: {
  userId: string;
  actionId: string;
  value?: string;
  channelId: string;
  messageTs: string;
  threadTs?: string;
  responseUrl: string;
}) {
  return {
    type: 'block_actions',
    token: 'verification-token',
    api_app_id: 'A0APP',
    trigger_id: 'trigger.2',
    team: { id: 'T0TEAM', domain: 'test' },
    user: { id: o.userId, username: 'someone', name: 'someone', team_id: 'T0TEAM' },
    container: { type: 'message', message_ts: o.messageTs, channel_id: o.channelId, is_ephemeral: false },
    channel: { id: o.channelId, name: 'general' },
    message: {
      type: 'message',
      ts: o.messageTs,
      text: 'Approval needed',
      blocks: [],
      ...(o.threadTs ? { thread_ts: o.threadTs } : {}),
    },
    response_url: o.responseUrl,
    actions: [
      {
        type: 'button',
        action_id: o.actionId,
        block_id: 'approval',
        text: { type: 'plain_text', text: 'Approve' },
        value: o.value ?? '',
        action_ts: '1800000000.000001',
      },
    ],
  };
}

/** Feed one payload through Bolt's middleware chain; returns what was passed to ack(). */
export async function dispatch(app: App, body: Record<string, unknown>): Promise<unknown[]> {
  const acks: unknown[] = [];
  await app.processEvent({
    body,
    ack: async (response?: unknown) => {
      acks.push(response);
    },
  });
  return acks;
}

export interface ResponseUrlServer {
  url: string;
  bodies: unknown[];
  close(): Promise<void>;
}

/** Records POSTs to response_url (respond()) so tests never hit hooks.slack.com. */
export async function startResponseUrlServer(): Promise<ResponseUrlServer> {
  const bodies: unknown[] = [];
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c: Buffer) => (data += c.toString()));
    req.on('end', () => {
      try {
        bodies.push(JSON.parse(data));
      } catch {
        bodies.push(data);
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/response`,
    bodies,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** Every user-visible string in a chat.* call (text + section/markdown block text). */
export function visibleText(args: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof args.text === 'string') parts.push(args.text);
  if (typeof args.markdown_text === 'string') parts.push(args.markdown_text);
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if ((k === 'text' && typeof x === 'string') || (k === 'text' && x && typeof x === 'object')) {
          if (typeof x === 'string') parts.push(x);
          else walk(x);
        } else walk(x);
      }
    }
  };
  walk(args.blocks);
  return parts.join('\n');
}
