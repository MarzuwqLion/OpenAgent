/**
 * Persistent Playwright Chromium tools.
 *
 * - Lazy singleton persistent context on ./data/browser-profile, relaunched
 *   if it closes or crashes.
 * - All page actions are serialized with a mutex (one shared page).
 * - A11: every browser tool marks ctx.turnState.browserUsed = true, both when
 *   the call is announced (onInputAvailable, which the SDK runs before it
 *   evaluates needsApproval for later calls in the same step) and in execute.
 * - A06: extracted text is truncated.
 * - A24: browser_type always needs approval. The approval preview (built by
 *   agent.ts via browserApprovalPreview) shows the current page URL, the
 *   selector and the text; execute refuses to type if the page's origin has
 *   changed since that preview was shown.
 * - A25 (REVIEW-H1a): SSRF hard block. Every request the browser makes is
 *   vetted twice: a context-level route/WebSocket interceptor aborts requests
 *   whose host is, or resolves to, a loopback, link-local/metadata, private,
 *   CGNAT, unique-local, unspecified, broadcast/multicast or reserved address;
 *   and Chromium is forced through the pinning egress proxy in net-guard.ts,
 *   which catches redirect hops and worker traffic and makes DNS rebinding
 *   impossible. browser_navigate also checks before launching Chromium.
 * - A25 (REVIEW-H1b): cross-site hops need approval. Once a browser tool ran
 *   in the turn, browser_navigate to a host other than the current page's
 *   (leading `www.` ignored) asks first; the preview shows the current page
 *   and the full target URL so data smuggled in a query string is visible.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { tool, type ModelMessage } from 'ai';
import { z } from 'zod';
import type { BrowserContext, Page } from 'playwright';
import { dataPaths } from '../config.js';
import type { ToolContext } from '../types.js';
import {
  blocksSince,
  blockedHostnameReason,
  checkRequestUrl,
  normalizeHost,
  currentBlockSeq,
  recordBlock,
  resolveDestination,
  startEgressProxy,
  type BlockEvent,
  type EgressProxy,
} from './net-guard.js';
import { errorMessage, Mutex, truncateToolResult } from './util.js';

const NAV_TIMEOUT_MS = 30_000;
const ACTION_TIMEOUT_MS = 10_000;

let context: BrowserContext | undefined;
let launching: Promise<BrowserContext> | undefined;
const pageMutex = new Mutex();

// A25: one in-process egress proxy, recreated if it ever closes (REVIEW-L12).
let egress: Promise<EgressProxy> | undefined;
let egressReady: EgressProxy | undefined;
async function getEgressProxy(): Promise<EgressProxy> {
  if (egressReady?.isClosed()) {
    egress = undefined;
    egressReady = undefined;
  }
  egress ??= startEgressProxy().then(
    (p) => (egressReady = p),
    (err: unknown) => {
      egress = undefined;
      throw err;
    },
  );
  return egress;
}

// REVIEW-L12: which proxy each context was launched with, so a context that
// points at a closed proxy is relaunched instead of failing until restart.
const contextProxy = new WeakMap<BrowserContext, EgressProxy>();

const BLOCKED_PREFIX = 'blocked: private/metadata address';

type Verdict = Awaited<ReturnType<typeof checkRequestUrl>>;

async function vet(url: string): Promise<Verdict> {
  try {
    return await checkRequestUrl(url);
  } catch (err) {
    return { ok: false, host: '', reason: `could not vet request (${errorMessage(err)})` };
  }
}

/**
 * A25: install the request-level guard on a context. Covers navigations,
 * iframes, subresources, page-script fetch/XHR and WebSockets of every page
 * in the context. Fails closed: a request that cannot be vetted is aborted.
 */
async function installRequestGuard(ctx: BrowserContext): Promise<void> {
  await ctx.route(
    () => true,
    async (route) => {
      const url = route.request().url();
      const verdict = await vet(url);
      if (verdict.ok) {
        await route.continue().catch(() => undefined);
        return;
      }
      recordBlock({ layer: 'route', host: verdict.host, reason: verdict.reason, url });
      await route.abort('blockedbyclient').catch(() => undefined);
    },
  );
  await ctx.routeWebSocket(
    () => true,
    async (ws) => {
      const url = ws.url();
      const verdict = await vet(url);
      if (verdict.ok) {
        ws.connectToServer(); // no handlers: messages are forwarded both ways
        return;
      }
      recordBlock({ layer: 'websocket', host: verdict.host, reason: verdict.reason, url });
      await ws.close({ code: 1008, reason: BLOCKED_PREFIX }).catch(() => undefined);
    },
  );
}

/**
 * A25: launch a persistent Chromium context with the egress guard in place
 * before any page loads. Exported for diagnostics and the smoke test; the
 * tools use the shared singleton below.
 */
export async function launchGuardedContext(userDataDir: string): Promise<BrowserContext> {
  const { chromium } = await import('playwright');
  const proxy = await getEgressProxy();
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    // '<-loopback>' explicitly: loopback goes through the proxy too (and is refused
    // there), regardless of PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK.
    proxy: { server: proxy.url, bypass: '<-loopback>' },
    // Service-worker fetches bypass page routing; browsing does not need them.
    serviceWorkers: 'block',
    args: [
      // WebRTC may only use proxied (TCP, vetted) connections: no direct UDP to internal hosts.
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      // No QUIC/HTTP3/WebTransport, which would not go through the HTTP proxy.
      '--disable-quic',
    ],
  });
  try {
    await installRequestGuard(ctx);
  } catch (err) {
    await ctx.close().catch(() => undefined);
    throw err;
  }
  contextProxy.set(ctx, proxy);
  return ctx;
}

async function getContext(): Promise<BrowserContext> {
  if (context && contextProxy.get(context)?.isClosed()) await closeBrowser(); // REVIEW-L12
  if (context) return context;
  launching ??= (async () => {
    const dir = dataPaths().browserProfile;
    await fsp.mkdir(dir, { recursive: true });
    const ctx = await launchGuardedContext(dir);
    ctx.setDefaultTimeout(ACTION_TIMEOUT_MS);
    ctx.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
    ctx.on('close', () => {
      if (context === ctx) context = undefined;
    });
    context = ctx;
    return ctx;
  })().finally(() => {
    launching = undefined;
  });
  return launching;
}

async function getPage(): Promise<Page> {
  const ctx = await getContext();
  const open = ctx.pages().filter((p) => !p.isClosed());
  return open[open.length - 1] ?? (await ctx.newPage());
}

/** Run `fn` on the shared page, serialized; relaunch once if the browser died. */
async function withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
  return pageMutex.run(async () => {
    try {
      return await fn(await getPage());
    } catch (err) {
      if (/Target .*closed|Browser has been closed|browser has disconnected/i.test(errorMessage(err))) {
        await closeBrowser();
        return fn(await getPage());
      }
      throw err;
    }
  });
}

/** Close the shared browser context (shutdown, doctor). */
export async function closeBrowser(): Promise<void> {
  const ctx = context;
  context = undefined;
  if (ctx) await ctx.close().catch(() => undefined);
}

/** URL of the shared page right now, without launching Chromium. */
let pageUrlForTests: string | undefined;
/** Test seam: pretend the shared page is at `url` (undefined restores the real page). */
export function setCurrentPageUrlForTests(url?: string): void {
  pageUrlForTests = url;
}

export function currentPageUrl(): string {
  if (pageUrlForTests !== undefined) return pageUrlForTests;
  const open = context?.pages().filter((p) => !p.isClosed()) ?? [];
  return open[open.length - 1]?.url() ?? 'about:blank';
}

function originOf(raw: string): string {
  try {
    return new URL(raw).origin;
  } catch {
    return raw;
  }
}

// A24: page URL shown in each browser_type approval preview, keyed by toolCallId.
// In memory only: after a restart the approval context is gone and typing is refused.
const APPROVED_TYPE_TARGETS_MAX = 200;
const approvedTypeTargets = new Map<string, string>();

/**
 * A24/A25: Slack approval preview for a gated browser tool, or undefined for
 * any other tool. Records the page URL it showed so browser_type's execute
 * can verify the page is still on the same origin.
 * A26: nothing is clipped. The URL, selector, text and target URL are shown
 * in full; the agent auto-denies calls whose preview exceeds
 * APPROVAL_PREVIEW_MAX. `_max` is accepted for old callers and ignored.
 */
export function browserApprovalPreview(toolName: string, toolCallId: string, input: unknown, _max?: number): string | undefined {
  if (toolName === 'browser_navigate') {
    // A25 + A26: cross-site hop; the complete target URL, query string included.
    const target = String((input as { url?: unknown } | null)?.url ?? '');
    return `Open another site\nCurrent page: ${currentPageUrl()}\nTarget URL: ${target}`;
  }
  if (toolName !== 'browser_type') return undefined;
  const { selector, text, submit } = (input ?? {}) as { selector?: unknown; text?: unknown; submit?: unknown };
  const url = currentPageUrl();
  approvedTypeTargets.delete(toolCallId);
  approvedTypeTargets.set(toolCallId, url);
  while (approvedTypeTargets.size > APPROVED_TYPE_TARGETS_MAX) {
    const oldest = approvedTypeTargets.keys().next().value;
    if (oldest === undefined) break;
    approvedTypeTargets.delete(oldest);
  }
  return (
    `Type into page\nURL: ${url}\nSelector: ${String(selector ?? '')}\n` +
    `${submit ? 'Then press Enter\n' : ''}Text: ${String(text ?? '')}`
  );
}

// A25: the call that first set browserUsed in a turn. The SDK runs a call's
// onInputAvailable (which marks the turn) BEFORE that same call's
// needsApproval, so without this the first navigate of a turn would count
// as "browser already used".
const firstBrowserCall = new WeakMap<ToolContext['turnState'], string>();

function markBrowserUsed(ctx: ToolContext, toolCallId?: string): void {
  if (!ctx.turnState.browserUsed) firstBrowserCall.set(ctx.turnState, toolCallId ?? '');
  ctx.turnState.browserUsed = true; // A11
}

/**
 * A25 (A11 semantics): did a browser tool run earlier in this turn, other
 * than the call `toolCallId` itself? Checks turnState and any browser_* call
 * after the last user message (a turn resumed after an approval).
 */
function browserUsedBefore(ctx: ToolContext, toolCallId: string, messages: readonly ModelMessage[] | undefined): boolean {
  if (ctx.turnState.browserUsed && firstBrowserCall.get(ctx.turnState) !== toolCallId) return true;
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
    const m = messages?.[i];
    if (!m) continue;
    if (m.role === 'user') return false;
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      const hit = m.content.some(
        (p) => p.type === 'tool-call' && p.toolName.startsWith('browser_') && p.toolCallId !== toolCallId,
      );
      if (hit) return true;
    }
  }
  return false;
}

/** A25: host identity for cross-site checks: case-insensitive, trailing dots and a leading `www.` ignored. */
function siteKey(host: string): string {
  return normalizeHost(host).replace(/^www\./, '');
}

/**
 * A25: browser_navigate needs approval when a browser tool already ran in
 * this turn AND the target host differs from the current page's host (no
 * real page open counts as different). Scheme and port are ignored. URLs
 * that execute will refuse anyway (invalid, non-http(s), or hard-blocked
 * internal addresses) never ask for approval.
 */
export async function navigateNeedsApproval(
  ctx: ToolContext,
  input: { url?: unknown },
  options: { toolCallId?: string; messages?: readonly ModelMessage[] } = {},
): Promise<boolean> {
  if (!browserUsedBefore(ctx, options.toolCallId ?? '', options.messages)) return false;
  let target: URL;
  try {
    target = checkUrl(String(input?.url ?? ''));
  } catch {
    return false; // refused in execute, no buttons
  }
  const dest = await resolveDestination(target.hostname);
  if (!dest.ok) return false; // A25 hard block: refused in execute regardless of approval
  let currentHost: string | undefined;
  try {
    const cur = new URL(currentPageUrl());
    if (cur.protocol === 'http:' || cur.protocol === 'https:') currentHost = cur.hostname;
  } catch {
    currentHost = undefined;
  }
  if (!currentHost) return true;
  return siteKey(currentHost) !== siteKey(target.hostname);
}

function checkUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`invalid URL: ${raw}`);
  }
  // No file:, chrome:, data: etc.: the browser runs as the app user and could otherwise read ./data.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`only http(s) URLs are allowed, got ${url.protocol}`);
  }
  // A25: IP literals and reserved names fail fast, without DNS or Chromium.
  const literal = blockedHostnameReason(url.hostname);
  if (literal) throw new Error(blockedMessage(url.hostname, literal));
  return url;
}

function blockedMessage(host: string, reason: string): string {
  return (
    `${BLOCKED_PREFIX} (${host}: ${reason}). The browser cannot open loopback, link-local/cloud-metadata, ` +
    'private, CGNAT or other internal addresses. Nothing was loaded from there; tell the user.'
  );
}

/** A25: pre-navigation check, including DNS (blocked if ANY resolved address is internal). */
async function assertPublicUrl(raw: string): Promise<URL> {
  const url = checkUrl(raw);
  const d = await resolveDestination(url.hostname);
  if (!d.ok) throw new Error(blockedMessage(d.host, d.reason));
  return url;
}

/** A25: refuse to read or capture a page whose own URL is an internal destination. */
async function assertPageIsPublic(page: Page): Promise<void> {
  const current = page.url();
  if (!/^(https?|wss?):/i.test(current)) return;
  const v = await vet(current);
  if (v.ok) return;
  await page.goto('about:blank').catch(() => undefined);
  throw new Error(blockedMessage(v.host, v.reason));
}

/** A25: short note about requests the guard refused during an action. */
function blockNote(events: BlockEvent[]): string {
  if (events.length === 0) return '';
  const hosts = [...new Set(events.map((e) => e.host || '(unknown)'))].slice(0, 5).join(', ');
  return `\nNote: ${BLOCKED_PREFIX}; ${events.length} request(s) from this page to internal hosts were refused (${hosts}).`;
}

export function createBrowserTools(ctx: ToolContext) {
  const mark = (opts?: { toolCallId?: string }) => markBrowserUsed(ctx, opts?.toolCallId);

  const browser_navigate = tool({
    description:
      'Open a URL (http/https) in the persistent headless Chromium browser. Returns the final URL and page title. ' +
      'After the browser has been used in this turn, moving to a different site needs the user to approve in Slack.',
    inputSchema: z.object({ url: z.string().describe('Absolute http(s) URL') }),
    needsApproval: (input, options) => navigateNeedsApproval(ctx, input, options), // A25: cross-site hops
    onInputAvailable: mark,
    execute: async ({ url }) => {
      mark();
      const target = await assertPublicUrl(url); // A25: fail fast with a clear message
      return withPage(async (page) => {
        const since = currentBlockSeq();
        let res: Awaited<ReturnType<Page['goto']>>;
        try {
          res = await page.goto(target.toString(), { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
        } catch (err) {
          const blocked = blocksSince(since)[0];
          if (blocked) throw new Error(blockedMessage(blocked.host, `${blocked.reason}; reached via ${target.host}`));
          throw err;
        }
        await assertPageIsPublic(page); // A25: e.g. a plain-HTTP redirect hop the proxy answered with 403
        return `Loaded ${page.url()} (HTTP ${res?.status() ?? 'n/a'})\nTitle: ${await page.title()}${blockNote(blocksSince(since))}`;
      });
    },
  });

  const browser_extract_text = tool({
    description:
      'Return the visible text of the current page, or of the first element matching a CSS selector. Long text is truncated.',
    inputSchema: z.object({ selector: z.string().optional().describe('CSS selector; defaults to the whole page body') }),
    onInputAvailable: mark,
    execute: async ({ selector }) => {
      mark();
      return withPage(async (page) => {
        await assertPageIsPublic(page); // A25
        const text = await page.locator(selector?.trim() || 'body').first().innerText();
        return truncateToolResult(`URL: ${page.url()}\n\n${text}`);
      });
    },
  });

  const browser_click = tool({
    description: 'Click the first element matching a CSS or Playwright text selector (e.g. "text=Sign in").',
    inputSchema: z.object({ selector: z.string() }),
    onInputAvailable: mark,
    execute: async ({ selector }) => {
      mark();
      return withPage(async (page) => {
        const since = currentBlockSeq();
        await page.locator(selector).first().click();
        await page.waitForLoadState('domcontentloaded').catch(() => undefined);
        await assertPageIsPublic(page); // A25
        return `Clicked ${selector}. Now at ${page.url()}${blockNote(blocksSince(since))}`;
      });
    },
  });

  const browser_type = tool({
    description:
      'Fill text into the first input matching a selector; optionally press Enter afterwards. ' +
      'Always requires the user to approve in Slack (they see the page URL, selector and text).',
    inputSchema: z.object({
      selector: z.string(),
      text: z.string(),
      submit: z.boolean().optional().describe('Press Enter after typing'),
    }),
    needsApproval: true, // A24: typing into web pages always needs approval
    onInputAvailable: mark,
    execute: async ({ selector, text, submit }, { toolCallId }) => {
      mark();
      // A24: refuse if the page moved to another origin since the user saw the preview.
      const approvedUrl = approvedTypeTargets.get(toolCallId);
      approvedTypeTargets.delete(toolCallId);
      if (approvedUrl === undefined) {
        throw new Error('approval context for this browser_type call is gone (agent restarted?); nothing was typed. Ask again.');
      }
      return withPage(async (page) => {
        if (originOf(page.url()) !== originOf(approvedUrl)) {
          throw new Error(
            `page changed since approval (approved on ${approvedUrl}, now on ${page.url()}); nothing was typed`,
          );
        }
        const field = page.locator(selector).first();
        await field.fill(text);
        if (submit) {
          await field.press('Enter');
          await page.waitForLoadState('domcontentloaded').catch(() => undefined);
        }
        return `Typed ${text.length} chars into ${selector}${submit ? ' and pressed Enter' : ''}. Now at ${page.url()}`;
      });
    },
  });

  const browser_screenshot = tool({
    description: 'Take a PNG screenshot of the current page, save it to the workspace and upload it to this Slack thread.',
    inputSchema: z.object({ fullPage: z.boolean().optional() }),
    onInputAvailable: mark,
    execute: async ({ fullPage }) => {
      mark();
      const dir = dataPaths().workspace;
      await fsp.mkdir(dir, { recursive: true });
      const file = path.join(dir, `screenshot-${Date.now()}.png`);
      const pageUrl = await withPage(async (page) => {
        await assertPageIsPublic(page); // A25
        await page.screenshot({ path: file, fullPage: fullPage ?? false });
        return page.url();
      });
      await ctx.slack.uploadFile(ctx.channelId, ctx.threadTs, file, `Screenshot of ${pageUrl}`);
      return `Screenshot of ${pageUrl} saved as workspace/${path.basename(file)} and uploaded to the thread.`;
    },
  });

  return { browser_navigate, browser_extract_text, browser_click, browser_type, browser_screenshot };
}
