/**
 * `npm run doctor` (host, via tsx) / `npm run doctor:prod` (container, compiled).
 * Prints one PASS/FAIL/SKIP line per check and exits non-zero on any FAIL.
 * Never prints secret values.
 *
 * Deliberately imports only config.ts and db.ts from the app: llm.ts, skills.ts,
 * agent.ts and slack.ts are not needed to diagnose the environment.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { webApi } from '@slack/bolt';
import { chromium } from 'playwright';
import { ConfigError, configuredProviders, dataPaths, getConfig } from './config.js';
import { closeDb, getSetting, initDb, setSetting } from './db.js';

type Status = 'PASS' | 'FAIL' | 'SKIP';
interface Result {
  status: Status;
  name: string;
  detail: string;
}

const results: Result[] = [];

function record(status: Status, name: string, detail: string): void {
  results.push({ status, name, detail });
  const tag = status === 'PASS' ? '[PASS]' : status === 'FAIL' ? '[FAIL]' : '[SKIP]';
  const lines = detail.split('\n');
  console.log(`${tag} ${name}: ${lines[0]}`);
  for (const extra of lines.slice(1)) console.log(`       ${extra}`);
}

/** Show only the token prefix so the user can tell which kind it is. */
export function maskSecret(value: string | undefined): string {
  if (!value) return '(unset)';
  const prefix = value.match(/^[a-z]+-/)?.[0] ?? '';
  return `${prefix}***(${value.length} chars)`;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message.split('\n')[0]! : String(e);
}

async function check(name: string, fn: () => Promise<string | { skip: string }> | string | { skip: string }): Promise<void> {
  try {
    const out = await fn();
    if (typeof out === 'string') record('PASS', name, out);
    else record('SKIP', name, out.skip);
  } catch (e) {
    record('FAIL', name, e instanceof Error ? e.message.split('\n').slice(0, 12).join('\n') : String(e));
  }
}

function inContainer(): boolean {
  return fs.existsSync('/.dockerenv') || process.env.container !== undefined;
}

function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Run a command as the sandbox user (A09). Returns true if it succeeded. */
function asSandbox(cmd: string, script: string): boolean {
  try {
    execFileSync(
      'setpriv',
      ['--reuid=sandbox', '--regid=sandbox', '--clear-groups', cmd, '-c', script],
      { stdio: 'ignore' },
    );
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const paths = dataPaths();
  console.log(`OpenAgent doctor (node ${process.version}, data dir ${paths.root})\n`);

  // 1. Env validation (A07, A18, A23)
  let cfg: ReturnType<typeof getConfig> | undefined;
  await check('env (.env validation)', () => {
    try {
      cfg = getConfig();
    } catch (e) {
      if (e instanceof ConfigError) {
        throw new Error(
          `${e.issues.length} problem(s), fix them in .env:\n${e.issues.map((i) => `- ${i}`).join('\n')}`,
        );
      }
      throw e;
    }
    return `valid; providers: ${configuredProviders(cfg).join(', ')}; default model ${cfg.DEFAULT_MODEL}`;
  });

  // 2. TZ and ALLOWED_SLACK_USER_IDS explicitly set (not just defaulted)
  await check('TZ set', () => {
    const tz = process.env.TZ?.trim();
    if (!tz) throw new Error('TZ is not set; schedules would fire in UTC. Set e.g. TZ=America/New_York in .env');
    return tz;
  });
  await check('ALLOWED_SLACK_USER_IDS set', () => {
    const ids = (process.env.ALLOWED_SLACK_USER_IDS ?? '').split(',').filter((s) => s.trim());
    if (ids.length === 0) throw new Error('not set; nobody could talk to the bot. Set comma-separated Slack member IDs');
    return `${ids.length} user(s) allowed`;
  });

  // 3. SQLite read/write against the real DB path
  await check('SQLite read/write', () => {
    try {
      initDb(paths.db);
      const probe = `doctor-${Date.now()}`;
      setSetting('doctor_probe', probe);
      const back = getSetting('doctor_probe');
      setSetting('doctor_probe', null);
      if (back !== probe) throw new Error('read-back value did not match what was written');
      return `${paths.db} OK`;
    } finally {
      closeDb();
    }
  });

  // 4. git + data repo (A21)
  await check('git', () => git(['--version']));
  await check('data repo', () => {
    if (!fs.existsSync(path.join(paths.root, '.git'))) {
      return { skip: 'no .git in data dir yet (created on first boot)' };
    }
    git(['-C', paths.root, '-c', `safe.directory=${paths.root}`, 'status', '--porcelain']);
    return 'git status OK';
  });

  // 5. Headless Chromium
  await check('headless Chromium', async () => {
    let browser;
    try {
      browser = await chromium.launch({ headless: true });
    } catch (e) {
      throw new Error(`${errMsg(e)}\nHint: run "npx playwright install chromium" (the Docker image ships it)`);
    }
    try {
      const page = await browser.newPage();
      await page.setContent('<title>ok</title>');
      return `launched Chromium ${browser.version()}`;
    } finally {
      await browser.close();
    }
  });

  // 6. Slack tokens
  const botToken = process.env.SLACK_BOT_TOKEN?.trim();
  const appToken = process.env.SLACK_APP_TOKEN?.trim();
  await check('Slack bot token (auth.test)', async () => {
    if (!botToken || botToken.endsWith('...')) throw new Error('SLACK_BOT_TOKEN is not set or is still the .env.example placeholder (expected xoxb-...)');
    if (!botToken.startsWith('xoxb-')) throw new Error(`SLACK_BOT_TOKEN ${maskSecret(botToken)} must start with xoxb-`);
    const res = await new webApi.WebClient(botToken).auth.test();
    return `workspace "${res.team}", bot user ${res.user}`;
  });
  await check('Slack app token (apps.connections.open)', async () => {
    if (!appToken || appToken.endsWith('...')) throw new Error('SLACK_APP_TOKEN is not set or is still the .env.example placeholder (expected xapp-...)');
    if (!appToken.startsWith('xapp-')) throw new Error(`SLACK_APP_TOKEN ${maskSecret(appToken)} must start with xapp-`);
    const res = await new webApi.WebClient(appToken).apps.connections.open();
    if (!res.ok) throw new Error(res.error ?? 'apps.connections.open failed');
    return 'Socket Mode connection URL granted';
  });

  // 7. A09 isolation (container only)
  await check('A09 sandbox isolation', () => {
    if (!inContainer()) return { skip: 'not running inside the container' };
    if (typeof process.getuid === 'function' && process.getuid() !== 0) {
      throw new Error('Node is not running as root, so bash cannot switch to the sandbox user');
    }
    try {
      execFileSync('id', ['sandbox'], { stdio: 'ignore' });
    } catch {
      throw new Error('user "sandbox" does not exist in this image');
    }
    // Probe files only when the real ones exist; also check directory traversal rules.
    const problems: string[] = [];
    if (fs.existsSync(paths.db) && asSandbox('sh', `cat '${paths.db}' >/dev/null 2>&1`)) {
      problems.push('sandbox CAN read agent.db');
    }
    if (fs.existsSync(paths.memory) && asSandbox('sh', `echo x >> '${paths.memory}' 2>/dev/null`)) {
      problems.push('sandbox CAN write MEMORY.md');
    }
    if (!asSandbox('sh', `touch '${paths.workspace}/.doctor-probe' && rm -f '${paths.workspace}/.doctor-probe'`)) {
      problems.push('sandbox cannot write to workspace/');
    }
    if (problems.length > 0) throw new Error(problems.join('; '));
    return 'sandbox cannot read agent.db or write MEMORY.md, and can write workspace/';
  });

  const failed = results.filter((r) => r.status === 'FAIL');
  console.log(
    `\n${results.length - failed.length}/${results.length} checks passed or skipped; ` +
      (failed.length === 0 ? 'ready.' : `${failed.length} failed. Not ready.`),
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`doctor crashed: ${errMsg(e)}`);
  process.exit(2);
});
