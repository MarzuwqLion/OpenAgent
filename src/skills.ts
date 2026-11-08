/**
 * Skill files (./data/skills/*.md with YAML frontmatter), MEMORY.md, and the
 * git audit trail inside ./data.
 *
 * A21: ./data is its own git repo, nested inside the project checkout (which
 * ignores ./data). Every git call targets the data dir explicitly with
 * `git -C <root>`, so the project repo is never touched. Every write and
 * every git operation runs under withDataRepoLock, and only the changed
 * paths are staged.
 *
 * Paths are read at call time from dataPaths() (DATA_DIR), never at load.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Cron } from 'croner';
import { execa } from 'execa';
import matter from 'gray-matter';
import { dataPaths } from './config.js';
import { withDataRepoLock } from './locks.js';

export interface SkillFrontmatter {
  name: string;
  description: string;
  schedule?: string;
  channel?: string;
  model?: string;
}

export type Skill = SkillFrontmatter & { body: string; path: string };

export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** A12: minimum allowed gap between two runs of a scheduled skill. */
export const MIN_SCHEDULE_GAP_MS = 15 * 60 * 1000;

const GIT_USER_NAME = 'OpenAgent';
const GIT_USER_EMAIL = 'openagent@localhost';

// A21
const GITIGNORE_ENTRIES = ['agent.db*', 'browser-profile/', 'workspace/'];

const SEED_MEMORY = `# Agent Memory

Global rules learned from user feedback. The agent appends new rules below and
commits every change to the git repo in this directory.

## Rules
`;

const SEED_SKILL_NAME = 'morning-briefing';
const SEED_SKILL: { fm: SkillFrontmatter; body: string } = {
  fm: {
    name: SEED_SKILL_NAME,
    description: 'Daily system and project briefing',
    schedule: '0 8 * * *',
    channel: '',
    model: '',
  },
  body: `## Objective
Compile a concise morning report for the team: anything notable in the
workspace, upcoming follow-ups, and a short plan for the day.

## Learned Rules & Corrections
- Keep summaries under 150 words.
`,
};

// ─── Validation ─────────────────────────────────────────────────────────

export function assertSkillName(name: string): void {
  if (typeof name !== 'string' || !SKILL_NAME_RE.test(name)) {
    throw new Error(
      `invalid skill name "${String(name)}": use 1-64 lowercase letters, digits and dashes, starting with a letter or digit`,
    );
  }
}

/**
 * A12: accept a 5-field cron expression (or a croner nickname like @daily)
 * whose runs are never closer together than 15 minutes.
 */
export function validateSchedule(expr: string): { ok: true } | { ok: false; reason: string } {
  if (typeof expr !== 'string' || expr.trim() === '') return { ok: false, reason: 'schedule is empty' };
  const pattern = expr.trim();
  if (!pattern.startsWith('@')) {
    const fields = pattern.split(/\s+/);
    if (fields.length !== 5) {
      return {
        ok: false,
        reason: `"${pattern}" has ${fields.length} fields; use a standard 5-field cron (minute hour day month weekday), no seconds field`,
      };
    }
  }
  let job: Cron;
  try {
    job = new Cron(pattern, { paused: true, timezone: 'UTC' });
  } catch (err) {
    return { ok: false, reason: `"${pattern}" is not a valid cron expression: ${(err as Error).message}` };
  }
  try {
    // Walk consecutive runs from a fixed reference and measure the smallest
    // gap. 400 runs covers more than a full cycle of any pattern whose runs
    // could fall closer than 15 minutes (day/month boundaries included).
    let prev = job.nextRun(new Date(Date.UTC(2025, 0, 1, 0, 0, 0)));
    if (!prev) return { ok: false, reason: `"${pattern}" never fires` };
    for (let i = 0; i < 400; i++) {
      const next = job.nextRun(prev);
      if (!next) break;
      const gap = next.getTime() - prev.getTime();
      if (gap < MIN_SCHEDULE_GAP_MS) {
        return {
          ok: false,
          reason: `"${pattern}" fires ${Math.round(gap / 1000)}s apart at times; schedules must be at least 15 minutes apart`,
        };
      }
      prev = next;
    }
  } finally {
    job.stop();
  }
  return { ok: true };
}

// ─── Git (A21) ──────────────────────────────────────────────────────────

/** Run git against the data repo only. `safe.directory` is passed on the command line (A21). */
async function git(args: string[], opts: { allowFail?: boolean } = {}): Promise<{ stdout: string; exitCode: number }> {
  const root = dataPaths().root;
  const safeDir = root.replace(/\\/g, '/');
  const res = await execa(
    'git',
    ['-c', `safe.directory=${safeDir}`, '-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', '-C', root, ...args],
    {
      reject: false,
      // Keep git off any project-level repo discovery above ./data.
      env: { GIT_CEILING_DIRECTORIES: path.dirname(root), GIT_TERMINAL_PROMPT: '0' },
    },
  );
  const exitCode = res.exitCode ?? 1;
  if (exitCode !== 0 && !opts.allowFail) {
    throw new Error(`git ${args.join(' ')} failed (${exitCode}): ${String(res.stderr || res.stdout).trim()}`);
  }
  return { stdout: String(res.stdout).trim(), exitCode };
}

/** Repo-relative path with forward slashes. */
function rel(absPath: string): string {
  return path.relative(dataPaths().root, absPath).split(path.sep).join('/');
}

async function headHash(): Promise<string> {
  return (await git(['rev-parse', 'HEAD'])).stdout;
}

/**
 * Stage exactly `paths` (repo-relative) and commit them. Returns the new
 * commit hash, or the current HEAD when nothing changed. Caller holds the lock.
 */
async function commitPaths(paths: string[], message: string): Promise<string> {
  if (paths.length > 0) await git(['add', '-A', '--', ...paths]);
  // Only our paths are ever staged (writes are serialized by the lock), so
  // committing the index commits exactly the changed paths.
  const diff = await git(['diff', '--cached', '--quiet'], { allowFail: true });
  if (diff.exitCode === 0) return headHash();
  const msg = message.trim() || `Update ${paths.join(', ')}`;
  await git(['commit', '--no-verify', '--quiet', '-m', msg]);
  return headHash();
}

function hasRepo(): boolean {
  return fs.existsSync(path.join(dataPaths().root, '.git'));
}

// ─── Init ───────────────────────────────────────────────────────────────

async function writeIfMissing(file: string, content: string): Promise<boolean> {
  try {
    await fsp.writeFile(file, content, { flag: 'wx' });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

/** Caller holds the lock. */
async function initDataRepoUnlocked(): Promise<void> {
  const p = dataPaths();
  for (const dir of [p.root, p.skills, p.workspace, p.browserProfile]) {
    await fsp.mkdir(dir, { recursive: true });
  }

  const freshRepo = !hasRepo();
  if (freshRepo) {
    await git(['init', '--quiet', '--initial-branch=main']);
  }
  // Repo-local identity and settings (idempotent).
  await git(['config', 'user.name', GIT_USER_NAME]);
  await git(['config', 'user.email', GIT_USER_EMAIL]);
  await git(['config', 'commit.gpgsign', 'false']);
  await git(['config', 'core.autocrlf', 'false']);

  // A21: .gitignore must cover the DB, browser profile and workspace.
  const changed: string[] = [];
  const gitignorePath = path.join(p.root, '.gitignore');
  const existing = fs.existsSync(gitignorePath) ? await fsp.readFile(gitignorePath, 'utf8') : '';
  const lines = existing.split(/\r?\n/).map((l) => l.trim());
  const missing = GITIGNORE_ENTRIES.filter((e) => !lines.includes(e));
  if (missing.length > 0) {
    const prefix = existing === '' || existing.endsWith('\n') ? existing : `${existing}\n`;
    await fsp.writeFile(gitignorePath, `${prefix}${missing.join('\n')}\n`);
    changed.push('.gitignore');
  }
  // Defensive: if an older layout ever tracked ignored files, untrack them.
  let untracked = false;
  if (!freshRepo) {
    const tracked = await git(['ls-files', '--', 'agent.db*', 'browser-profile', 'workspace'], { allowFail: true });
    if (tracked.stdout !== '') {
      await git(['rm', '-r', '--cached', '--quiet', '--', ...tracked.stdout.split('\n')]);
      untracked = true;
    }
  }

  if (await writeIfMissing(p.memory, SEED_MEMORY)) changed.push(rel(p.memory));
  const seedSkillPath = path.join(p.skills, `${SEED_SKILL_NAME}.md`);
  if (freshRepo || !fs.existsSync(seedSkillPath)) {
    // Seed only into an empty skills dir, so a deleted seed isn't resurrected later.
    const hasAnySkill = (await fsp.readdir(p.skills)).some((f) => f.endsWith('.md'));
    if (!hasAnySkill && (await writeIfMissing(seedSkillPath, serializeSkill(SEED_SKILL.fm, SEED_SKILL.body)))) {
      changed.push(rel(seedSkillPath));
    }
  }
  // First commit also picks up pre-existing MEMORY.md / skills that were never committed.
  if (freshRepo) {
    if (fs.existsSync(p.memory)) changed.push(rel(p.memory));
    for (const f of await fsp.readdir(p.skills)) if (f.endsWith('.md')) changed.push(`skills/${f}`);
  }

  const unique = [...new Set(changed)];
  if (unique.length > 0 || untracked) {
    await commitPaths(unique, freshRepo ? 'Initialize OpenAgent data repo' : 'Update data repo setup');
  }
}

/**
 * Create ./data, its subdirectories, the git repo (with .gitignore and
 * repo-local identity), and seed MEMORY.md and skills/morning-briefing.md
 * when missing. Idempotent: a second call makes no commit.
 */
export function initDataRepo(): Promise<void> {
  return withDataRepoLock(initDataRepoUnlocked);
}

async function ensureRepoUnlocked(): Promise<void> {
  if (!hasRepo()) await initDataRepoUnlocked();
}

// ─── Skills ─────────────────────────────────────────────────────────────

function str(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  return String(v);
}

function serializeSkill(fm: SkillFrontmatter, body: string): string {
  const data: Record<string, string> = { name: fm.name, description: fm.description ?? '' };
  for (const key of ['schedule', 'channel', 'model'] as const) {
    const v = fm[key];
    if (v !== undefined) data[key] = v;
  }
  assertBodyHasNoFence(body);
  const content = body.endsWith('\n') ? body : `${body}\n`;
  // REVIEW-C10: matter.stringify(string, …) would first PARSE the string with
  // gray-matter's default (eval-capable) options. With a file object nothing
  // is parsed (gray-matter/index.js: only `typeof file === 'string'` is
  // parsed; lib/stringify.js just dumps `data` with the YAML engine, js-yaml
  // safeDump, and appends `content` verbatim).
  return matter.stringify({ content }, data, YAML_ONLY);
}

/**
 * REVIEW-C10: a skill body may not start (after blank lines) with a `---`
 * fence of any kind. It could turn into frontmatter, or a `---js` block, if
 * the file were ever re-parsed without the header (A12 bypass, injection).
 */
export function assertBodyHasNoFence(body: string): void {
  if (/^﻿?(?:[ \t]*\r?\n)*[ \t]*---/.test(body)) {
    throw new Error('skill body must not start with a "---" line (frontmatter fences are not allowed in the body)');
  }
}

// REVIEW-M2: frontmatter is YAML only. gray-matter honours a language after the
// opening fence (`---js`, `---javascript`) and its javascript engine eval()s the
// block, so every non-YAML engine is replaced with one that refuses, and any
// non-YAML fence is rejected before gray-matter sees the file.
const refuseEngine = (lang: string) => ({
  parse: (): never => {
    throw new Error(`"${lang}" frontmatter is not allowed; skill frontmatter must be YAML`);
  },
});
const YAML_ONLY = {
  language: 'yaml',
  engines: { javascript: refuseEngine('javascript'), js: refuseEngine('js'), json: refuseEngine('json') },
};

/** gray-matter locked to YAML (REVIEW-M2). Every matter() parse goes through here. */
function parseFrontmatter(raw: string): matter.GrayMatterFile<string> {
  const text = raw.replace(/^﻿/, '');
  const fence = /^---([^\r\n]*)/.exec(text);
  const lang = fence?.[1]?.trim().toLowerCase();
  if (lang && lang !== 'yaml' && lang !== 'yml' && !lang.startsWith('-')) {
    throw new Error(`"---${lang}" frontmatter is not allowed; skill frontmatter must be YAML`);
  }
  // Passing options also bypasses gray-matter's global parse cache.
  return matter(text, YAML_ONLY);
}

function parseSkill(name: string, file: string, raw: string): Skill {
  const parsed = parseFrontmatter(raw);
  const d = parsed.data;
  const skill: Skill = {
    name,
    description: str(d.description) ?? '',
    body: parsed.content.replace(/^\r?\n/, ''),
    path: file,
  };
  const schedule = str(d.schedule);
  const channel = str(d.channel);
  const model = str(d.model);
  if (schedule !== undefined) skill.schedule = schedule;
  if (channel !== undefined) skill.channel = channel;
  if (model !== undefined) skill.model = model;
  return skill;
}

function skillPath(name: string): string {
  assertSkillName(name);
  return path.join(dataPaths().skills, `${name}.md`);
}

/** Every valid skill file, sorted by name. Unparsable files are skipped with a warning. */
export async function loadAllSkills(): Promise<Skill[]> {
  const dir = dataPaths().skills;
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const skills: Skill[] = [];
  for (const f of entries.sort()) {
    if (!f.endsWith('.md')) continue;
    const name = f.slice(0, -3);
    if (!SKILL_NAME_RE.test(name)) {
      console.warn(`[skills] skipping ${f}: file name is not a valid skill name`);
      continue;
    }
    const file = path.join(dir, f);
    try {
      skills.push(parseSkill(name, file, await fsp.readFile(file, 'utf8')));
    } catch (err) {
      console.warn(`[skills] skipping ${f}: ${(err as Error).message}`);
    }
  }
  return skills;
}

/** The skill, or undefined if no such file. Throws on an invalid name. */
export async function getSkill(name: string): Promise<Skill | undefined> {
  const file = skillPath(name);
  try {
    return parseSkill(name, file, await fsp.readFile(file, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

/**
 * Write skills/<name>.md and commit it. The file name is authoritative:
 * frontmatter.name is forced to `name`. A non-empty schedule must pass
 * validateSchedule (A12). Returns the commit hash (HEAD if unchanged).
 */
export async function saveSkill(
  name: string,
  frontmatter: SkillFrontmatter,
  content: string,
  commitMessage: string,
): Promise<string> {
  const file = skillPath(name);
  const schedule = frontmatter.schedule?.trim();
  if (schedule) {
    const v = validateSchedule(schedule);
    if (!v.ok) throw new Error(v.reason);
  }
  const fm: SkillFrontmatter = { ...frontmatter, name, description: frontmatter.description ?? '' };
  if (frontmatter.schedule !== undefined) fm.schedule = schedule ?? '';
  return withDataRepoLock(async () => {
    await ensureRepoUnlocked();
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, serializeSkill(fm, content));
    return commitPaths([rel(file)], commitMessage || `Update skill ${name}`);
  });
}

// ─── Memory ─────────────────────────────────────────────────────────────

export async function readMemory(): Promise<string> {
  try {
    return await fsp.readFile(dataPaths().memory, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}

/** Append `- <rule>` to MEMORY.md and commit. Returns the commit hash. */
export async function appendMemoryRule(rule: string, commitMessage: string): Promise<string> {
  const line = rule.replace(/\s*\r?\n\s*/g, ' ').trim();
  if (line === '') throw new Error('rule is empty');
  return withDataRepoLock(async () => {
    await ensureRepoUnlocked();
    const file = dataPaths().memory;
    let current = await readMemory();
    if (current === '') current = SEED_MEMORY;
    if (!current.endsWith('\n')) current += '\n';
    await fsp.writeFile(file, `${current}- ${line}\n`);
    return commitPaths([rel(file)], commitMessage || `Add memory rule: ${line.slice(0, 60)}`);
  });
}

// ─── Revert ─────────────────────────────────────────────────────────────

/**
 * Revert the most recent commit in the data repo (and only there) with a new
 * revert commit. Returns the revert commit's hash. Refuses to revert the
 * repo's initial commit.
 */
export async function revertLastDataCommit(): Promise<string> {
  return withDataRepoLock(async () => {
    if (!hasRepo()) throw new Error('data repo is not initialized');
    const parents = (await git(['rev-list', '--parents', '-n', '1', 'HEAD'])).stdout.split(' ');
    if (parents.length < 2) throw new Error('nothing to revert: HEAD is the initial commit');
    const res = await git(['revert', '--no-edit', 'HEAD'], { allowFail: true });
    if (res.exitCode !== 0) {
      await git(['revert', '--abort'], { allowFail: true });
      throw new Error('git revert failed (conflict or dirty tree); data repo left unchanged');
    }
    return headHash();
  });
}

/** One-line log of recent data-repo commits (newest first), for tools and diagnostics. */
export async function recentDataCommits(limit = 10): Promise<string[]> {
  return withDataRepoLock(async () => {
    if (!hasRepo()) return [];
    const out = await git(['log', `-n${limit}`, '--format=%h %s'], { allowFail: true });
    return out.stdout === '' ? [] : out.stdout.split('\n');
  });
}
