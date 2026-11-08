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
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { tool } from 'ai';
import { z } from 'zod';
import type { BrowserContext, Page } from 'playwright';
import { dataPaths } from '../config.js';
import type { ToolContext } from '../types.js';
import { errorMessage, Mutex, truncateToolResult } from './util.js';

const NAV_TIMEOUT_MS = 30_000;
const ACTION_TIMEOUT_MS = 10_000;

let context: BrowserContext | undefined;
let launching: Promise<BrowserContext> | undefined;
const pageMutex = new Mutex();

async function getContext(): Promise<BrowserContext> {
  if (context) return context;
  launching ??= (async () => {
    const { chromium } = await import('playwright');
    const dir = dataPaths().browserProfile;
    await fsp.mkdir(dir, { recursive: true });
    const ctx = await chromium.launchPersistentContext(dir, { headless: true });
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
export function currentPageUrl(): string {
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

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * A24: Slack approval preview for a gated browser tool, or undefined for any
 * other tool. Records the page URL it showed so execute can verify the page
 * is still on the same origin. Output stays within `max` chars; the URL and
 * selector are clipped first so the text to be typed stays visible.
 */
export function browserApprovalPreview(toolName: string, toolCallId: string, input: unknown, max = 500): string | undefined {
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
  const head =
    `Type into page\nURL: ${clip(url, 150)}\nSelector: ${clip(String(selector ?? ''), 100)}\n` +
    `${submit ? 'Then press Enter\n' : ''}Text: `;
  return head + clip(String(text ?? ''), Math.max(20, max - head.length));
}

function markBrowserUsed(ctx: ToolContext): void {
  ctx.turnState.browserUsed = true; // A11
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
  return url;
}

export function createBrowserTools(ctx: ToolContext) {
  const mark = () => markBrowserUsed(ctx);

  const browser_navigate = tool({
    description: 'Open a URL (http/https) in the persistent headless Chromium browser. Returns the final URL and page title.',
    inputSchema: z.object({ url: z.string().describe('Absolute http(s) URL') }),
    onInputAvailable: mark,
    execute: async ({ url }) => {
      mark();
      const target = checkUrl(url);
      return withPage(async (page) => {
        const res = await page.goto(target.toString(), { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
        return `Loaded ${page.url()} (HTTP ${res?.status() ?? 'n/a'})\nTitle: ${await page.title()}`;
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
        await page.locator(selector).first().click();
        await page.waitForLoadState('domcontentloaded').catch(() => undefined);
        return `Clicked ${selector}. Now at ${page.url()}`;
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
        await page.screenshot({ path: file, fullPage: fullPage ?? false });
        return page.url();
      });
      await ctx.slack.uploadFile(ctx.channelId, ctx.threadTs, file, `Screenshot of ${pageUrl}`);
      return `Screenshot of ${pageUrl} saved as workspace/${path.basename(file)} and uploaded to the thread.`;
    },
  });

  return { browser_navigate, browser_extract_text, browser_click, browser_type, browser_screenshot };
}
