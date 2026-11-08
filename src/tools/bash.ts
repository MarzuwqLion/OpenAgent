/**
 * bash tool: runs a shell command in ./data/workspace.
 *
 * A08: approval policy (bashNeedsApproval), wired as the tool's needsApproval.
 * A09: runs as the unprivileged `sandbox` user when the process is root on Linux.
 * A10: the child gets a scrubbed env (sandboxEnv) with extendEnv: false.
 * A06: output is truncated by truncateToolResult.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { tool } from 'ai';
import { execa } from 'execa';
import { z } from 'zod';
import { dataPaths, getConfig } from '../config.js';
import type { ToolContext } from '../types.js';
import { truncateToolResult } from './util.js';

export const BASH_TIMEOUT_MS = 60_000;

// A08
const SHELL_METACHARS = /[;&|`$()<>\n\r]/;
const ALLOWLIST = new Set(['ls', 'cat', 'head', 'tail', 'wc', 'grep', 'pwd', 'date', 'du', 'df', 'stat', 'file']);

/**
 * A08: whether a bash command needs human approval.
 * - `always`: every command does.
 * - `allowlist`: only commands with no shell metacharacters whose first word
 *   is in the read-only allowlist run without approval.
 */
export function bashNeedsApproval(cmd: string, mode: 'always' | 'allowlist'): boolean {
  if (mode !== 'allowlist') return true;
  if (typeof cmd !== 'string') return true;
  if (SHELL_METACHARS.test(cmd)) return true;
  const first = cmd.trim().split(/\s+/)[0] ?? '';
  return !ALLOWLIST.has(first);
}

const DEFAULT_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

function configuredTz(): string {
  try {
    return getConfig().TZ;
  } catch {
    return process.env.TZ?.trim() || 'UTC';
  }
}

/**
 * A10: the complete environment for child processes. Exactly PATH, HOME,
 * LANG and TZ; HOME is the workspace. No other process.env value (API keys,
 * Slack tokens) is ever copied.
 */
export function sandboxEnv(): Record<string, string> {
  return {
    PATH: process.env.PATH?.trim() || DEFAULT_PATH,
    HOME: dataPaths().workspace,
    LANG: process.env.LANG?.trim() || 'C.UTF-8',
    TZ: configuredTz(),
  };
}

// ─── A09: sandbox user ──────────────────────────────────────────────────

let sandboxIds: { uid: number; gid: number } | null | undefined;
let warnedNoSwitch = false;

/** Look up `sandbox` in /etc/passwd (cached). null when the user doesn't exist. */
function lookupSandboxUser(): { uid: number; gid: number } | null {
  if (sandboxIds !== undefined) return sandboxIds;
  sandboxIds = null;
  try {
    for (const line of fs.readFileSync('/etc/passwd', 'utf8').split('\n')) {
      const [name, , uid, gid] = line.split(':');
      if (name === 'sandbox' && uid && gid) {
        sandboxIds = { uid: Number(uid), gid: Number(gid) };
        break;
      }
    }
  } catch {
    // no /etc/passwd: leave null
  }
  return sandboxIds;
}

/**
 * A09: uid/gid to run as. As root on Linux, the `sandbox` user is mandatory
 * (running commands as root would expose agent.db). Otherwise (local dev,
 * Windows, macOS, non-root) the switch is skipped with a one-time warning.
 */
function sandboxCredentials(): { uid: number; gid: number } | undefined {
  const isRoot = process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0;
  if (!isRoot) {
    if (!warnedNoSwitch) {
      warnedNoSwitch = true;
      console.warn(
        '[bash] A09: not running as root on Linux; commands run as the current user (no sandbox uid switch). ' +
          'Expected in local development only.',
      );
    }
    return undefined;
  }
  const ids = lookupSandboxUser();
  if (!ids) {
    throw new Error(
      'A09: running as root but no "sandbox" user exists; refusing to run commands as root. Create the user (see Dockerfile).',
    );
  }
  return ids;
}

// ─── Execution ──────────────────────────────────────────────────────────

const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';

function shellCommand(command: string): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    // Dev only: prefer Git Bash for POSIX semantics, else cmd.exe.
    if (fs.existsSync(GIT_BASH)) return { file: GIT_BASH, args: ['-c', command] };
    return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', command] };
  }
  const file = fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
  return { file, args: ['-c', command] };
}

/** Kill the whole process tree/group rooted at `pid` (grandchildren included). */
function killTree(pid: number): void {
  if (process.platform === 'win32') {
    void execa('taskkill', ['/pid', String(pid), '/T', '/F'], { reject: false });
    return;
  }
  try {
    // detached: the shell leads its own process group. Only ever signal the
    // group (never a bare pid that may have been reused after exit).
    process.kill(-pid, 'SIGKILL');
  } catch {
    // group already gone
  }
}

export interface BashResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  timeoutMs: number;
}

/** Run `command` in the workspace with the sandbox env/user and a hard timeout. */
export async function runBash(command: string, opts: { timeoutMs?: number } = {}): Promise<BashResult> {
  const timeoutMs = opts.timeoutMs ?? BASH_TIMEOUT_MS;
  const workspace = dataPaths().workspace;
  await fsp.mkdir(workspace, { recursive: true });
  const creds = sandboxCredentials();
  const env: Record<string, string> = sandboxEnv();
  if (process.platform === 'win32') {
    // Windows dev only: these are needed for any process to start; not secrets.
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    if (process.env.ComSpec) env.ComSpec = process.env.ComSpec;
  }
  const { file, args } = shellCommand(command);

  const child = execa(file, args, {
    cwd: workspace,
    env,
    extendEnv: false, // A10
    ...(creds ? { uid: creds.uid, gid: creds.gid } : {}), // A09
    detached: process.platform !== 'win32', // own process group so the timeout kills grandchildren
    stdin: 'ignore',
    reject: false,
    buffer: false, // collected below, so output survives an abandoned pipe
    windowsHide: true,
  });

  const stdout = collect(child.stdout);
  const stderr = collect(child.stderr);
  let exitCode: number | null = null;
  const exited = new Promise<void>((resolve) => {
    child.nodeChildProcess.once('exit', (code) => {
      exitCode = code;
      resolve();
    });
    child.nodeChildProcess.once('error', () => resolve());
  });
  const settled = child.then(
    () => 'done' as const,
    () => 'done' as const,
  );

  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  try {
    if ((await Promise.race([exited.then(() => 'exited' as const), timeout])) === 'timeout') timedOut = true;
    // Kill the group on timeout, and after a normal exit reap anything the
    // command left running in the background (it would hold the pipes open).
    if (child.pid !== undefined && (timedOut || process.platform !== 'win32')) killTree(child.pid);
    // A grandchild that escaped the group (setsid, or MSYS on Windows dev) can
    // keep the pipes open: give the streams a moment, then abandon them.
    if ((await Promise.race([settled, delay(PIPE_GRACE_MS)])) !== 'done') {
      child.stdout?.destroy();
      child.stderr?.destroy();
    }
  } finally {
    clearTimeout(timer);
  }
  return {
    exitCode: timedOut ? null : exitCode,
    stdout: stdout.text(),
    stderr: stderr.text(),
    timedOut,
    timeoutMs,
  };
}

const PIPE_GRACE_MS = 2_000;
/** Per-stream cap on collected output; truncateToolResult trims further for the model. */
const MAX_COLLECT_BYTES = 2 * 1024 * 1024;

function delay(ms: number): Promise<'delay'> {
  return new Promise((resolve) => setTimeout(() => resolve('delay'), ms));
}

function collect(stream: NodeJS.ReadableStream | null): { text(): string } {
  const chunks: Buffer[] = [];
  let size = 0;
  let dropped = 0;
  stream?.on('data', (chunk: Buffer | string) => {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    if (size + buf.length <= MAX_COLLECT_BYTES) {
      chunks.push(buf);
      size += buf.length;
    } else {
      dropped += buf.length;
    }
  });
  stream?.on('error', () => undefined);
  return {
    text: () => Buffer.concat(chunks).toString('utf8') + (dropped > 0 ? `\n[${dropped} more bytes discarded]` : ''),
  };
}

/** Tool-facing rendering: exit code, stdout and stderr, truncated per A06. */
export function formatBashResult(r: BashResult): string {
  const status = r.timedOut
    ? `timed out after ${Math.round(r.timeoutMs / 1000)}s (process tree killed)`
    : `exit code ${r.exitCode ?? 'unknown'}`;
  const parts = [status];
  parts.push(`--- stdout ---\n${r.stdout === '' ? '(empty)' : r.stdout}`);
  if (r.stderr !== '') parts.push(`--- stderr ---\n${r.stderr}`);
  return truncateToolResult(parts.join('\n'));
}

// ─── Tool ───────────────────────────────────────────────────────────────

export function createBashTool(_ctx: ToolContext) {
  return tool({
    description:
      'Run a shell command (bash -c) in the agent workspace directory (./data/workspace) with a 60s timeout. ' +
      'Returns the exit code, stdout and stderr. Background processes are killed when the command finishes. ' +
      'Most commands require the user to approve them in Slack first.',
    inputSchema: z.object({ command: z.string().describe('The shell command to run') }),
    // A03 + A08: native SDK approval; mode is read at call time.
    needsApproval: ({ command }) => bashNeedsApproval(command, getConfig().BASH_APPROVAL_MODE),
    execute: async ({ command }) => formatBashResult(await runBash(command)),
  });
}
