/**
 * skills.ts: A21 data repo, A12 schedule guard, frontmatter parsing, and
 * skill-name path traversal. Uses real git in a temp DATA_DIR.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initDb } from '../src/db.js';
import { applyEnv, setupTestEnv, type TestEnv } from './helpers/env.js';
import { loadSrc, type SkillFrontmatter, type SkillsModule } from './helpers/modules.js';

applyEnv();
const skills = await loadSrc<SkillsModule>('skills.js');

let env: TestEnv;
beforeEach(async () => {
  env = await setupTestEnv({ db: false });
});
afterEach(async () => {
  await env.cleanup();
});

function git(...args: string[]): string {
  return execFileSync('git', ['-C', env.dataDir, ...args], { encoding: 'utf8' }).trim();
}
const commitCount = () => Number(git('rev-list', '--count', 'HEAD'));

const fm = (name: string, over: Partial<SkillFrontmatter> = {}): SkillFrontmatter => ({
  name,
  description: `${name} description`,
  schedule: '',
  channel: '',
  model: '',
  ...over,
});

describe.skipIf(!skills)('validateSchedule (A12)', () => {
  const ok = (e: string) => skills!.validateSchedule(e).ok;

  it('accepts schedules at most every 15 minutes', () => {
    expect(ok('0 8 * * *')).toBe(true);
    expect(ok('*/15 * * * *')).toBe(true);
    expect(ok('30 9 * * 1-5')).toBe(true);
  });

  it('rejects anything more frequent than every 15 minutes', () => {
    for (const e of ['* * * * *', '*/5 * * * *', '*/14 * * * *', '0,5 8 * * *', '* * * * * *', '*/30 * * * * *', '0 */1 * * * *']) {
      const r = skills!.validateSchedule(e);
      expect(r.ok, `"${e}" should be rejected`).toBe(false);
      if (!r.ok) expect(r.reason.length).toBeGreaterThan(0);
    }
  });

  it('rejects unparsable expressions', () => {
    for (const e of ['not a cron', '61 * * * *', '* * *', '']) {
      expect(ok(e), `"${e}" should be rejected`).toBe(false);
    }
  });
});

describe.skipIf(!skills)('initDataRepo (A21)', () => {
  it('creates the layout, seeds MEMORY.md and morning-briefing, and commits', async () => {
    await skills!.initDataRepo();
    for (const d of ['skills', 'workspace', 'browser-profile', '.git']) {
      expect(fs.existsSync(path.join(env.dataDir, d)), d).toBe(true);
    }
    expect(fs.existsSync(env.paths.memory)).toBe(true);
    expect(commitCount()).toBeGreaterThanOrEqual(1);
    const seeded = await skills!.getSkill('morning-briefing');
    expect(seeded?.name).toBe('morning-briefing');
    expect(seeded?.schedule).toBeTruthy();
  });

  it('is idempotent', async () => {
    await skills!.initDataRepo();
    const n = commitCount();
    await skills!.initDataRepo();
    expect(commitCount()).toBe(n);
  });

  it('writes .gitignore with agent.db*, browser-profile/ and workspace/', async () => {
    await skills!.initDataRepo();
    const gi = fs.readFileSync(path.join(env.dataDir, '.gitignore'), 'utf8');
    expect(gi).toContain('agent.db*');
    expect(gi).toContain('browser-profile/');
    expect(gi).toContain('workspace/');
  });

  it('sets repo-local user.name and user.email', async () => {
    await skills!.initDataRepo();
    expect(git('config', '--local', 'user.name').length).toBeGreaterThan(0);
    expect(git('config', '--local', 'user.email').length).toBeGreaterThan(0);
  });
});

describe.skipIf(!skills)('saving and committing (A21)', () => {
  beforeEach(async () => {
    await skills!.initDataRepo();
  });

  it('saveSkill produces a commit and returns its hash', async () => {
    const before = commitCount();
    const hash = await skills!.saveSkill('weekly-report', fm('weekly-report'), '## Objective\nDo it.\n', 'add weekly-report');
    expect(commitCount()).toBe(before + 1);
    expect(hash).toMatch(/^[0-9a-f]{7,40}$/);
    expect(git('rev-parse', 'HEAD').startsWith(hash)).toBe(true);
    expect(git('log', '-1', '--pretty=%s')).toBe('add weekly-report');
    const s = await skills!.getSkill('weekly-report');
    expect(s?.description).toBe('weekly-report description');
    expect(s?.body).toContain('Do it.');
  });

  it('git ls-files never includes agent.db*, browser-profile/ or workspace/', async () => {
    initDb(env.dbPath); // creates agent.db, -wal, -shm
    fs.writeFileSync(path.join(env.paths.browserProfile, 'Cookies'), 'session=secret');
    fs.writeFileSync(path.join(env.paths.workspace, 'scratch.txt'), 'scratch');
    await skills!.saveSkill('weekly-report', fm('weekly-report'), 'body', 'add');
    await skills!.appendMemoryRule('Keep summaries short.', 'rule');
    const files = git('ls-files').split('\n');
    expect(files.some((f) => f.startsWith('agent.db'))).toBe(false);
    expect(files.some((f) => f.startsWith('browser-profile/'))).toBe(false);
    expect(files.some((f) => f.startsWith('workspace/'))).toBe(false);
    expect(files).toContain('MEMORY.md');
    expect(files).toContain('skills/weekly-report.md');
    // and nothing sensitive in history at all
    const everything = git('log', '--all', '--name-only', '--pretty=format:');
    expect(everything).not.toMatch(/agent\.db|browser-profile|workspace\//);
  });

  it('stages only the changed file, not unrelated untracked files', async () => {
    fs.writeFileSync(path.join(env.dataDir, 'stray.txt'), 'not mine');
    await skills!.saveSkill('weekly-report', fm('weekly-report'), 'body', 'add');
    expect(git('ls-files').split('\n')).not.toContain('stray.txt');
  });

  it('appendMemoryRule commits and the rule is readable', async () => {
    const before = commitCount();
    const hash = await skills!.appendMemoryRule('Always answer in English.', 'learn: english');
    expect(commitCount()).toBe(before + 1);
    expect(git('rev-parse', 'HEAD').startsWith(hash)).toBe(true);
    expect(await skills!.readMemory()).toContain('Always answer in English.');
  });

  it('revertLastDataCommit restores the previous content and commits the revert', async () => {
    await skills!.saveSkill('weekly-report', fm('weekly-report'), 'VERSION ONE', 'v1');
    await skills!.saveSkill('weekly-report', fm('weekly-report'), 'VERSION TWO', 'v2');
    expect((await skills!.getSkill('weekly-report'))?.body).toContain('VERSION TWO');
    const before = commitCount();
    const hash = await skills!.revertLastDataCommit();
    expect(hash).toMatch(/^[0-9a-f]{7,40}$/);
    expect(commitCount()).toBe(before + 1); // history is kept, not rewritten
    const body = (await skills!.getSkill('weekly-report'))?.body ?? '';
    expect(body).toContain('VERSION ONE');
    expect(body).not.toContain('VERSION TWO');
  });

  it('revert restores MEMORY.md too', async () => {
    // EOL-insensitive: Git for Windows ships core.autocrlf=true at system level.
    const lf = (s: string) => s.replace(/\r\n/g, '\n');
    const original = await skills!.readMemory();
    await skills!.appendMemoryRule('Injected rule', 'bad rule');
    expect(await skills!.readMemory()).toContain('Injected rule');
    await skills!.revertLastDataCommit();
    expect(lf(await skills!.readMemory())).toBe(lf(original));
  });

  it('revert never touches the app repo or files outside DATA_DIR', async () => {
    // The data repo must be its own repo, not the enclosing project's.
    expect(path.resolve(git('rev-parse', '--show-toplevel'))).toBe(path.resolve(fs.realpathSync(env.dataDir)));
  });

  it('parallel saves all succeed (no index.lock collisions) and each gets a commit', async () => {
    const before = commitCount();
    const names = Array.from({ length: 6 }, (_, i) => `parallel-${i}`);
    const hashes = await Promise.all(
      names.map((n) => skills!.saveSkill(n, fm(n), `body ${n}`, `add ${n}`)),
    );
    const memHashes = await Promise.all([
      skills!.appendMemoryRule('rule A', 'a'),
      skills!.appendMemoryRule('rule B', 'b'),
    ]);
    expect(new Set([...hashes, ...memHashes]).size).toBe(8);
    expect(commitCount()).toBe(before + 8);
    const mem = await skills!.readMemory();
    expect(mem).toContain('rule A');
    expect(mem).toContain('rule B');
    expect(git('status', '--porcelain', '--', 'skills', 'MEMORY.md')).toBe('');
  });
});

describe.skipIf(!skills)('skill names and paths', () => {
  beforeEach(async () => {
    await skills!.initDataRepo();
  });

  it('saveSkill rejects path traversal and invalid names, writing nothing', async () => {
    const outside = path.resolve(env.dataDir, '..', 'x.md');
    for (const bad of ['../../x', '../x', 'a/b', 'a\\b', '.hidden', 'UPPER', '', 'x'.repeat(65), 'name.md', '-lead']) {
      await expect(skills!.saveSkill(bad, fm(bad), 'pwned', 'evil'), `"${bad}"`).rejects.toThrow();
    }
    expect(fs.existsSync(outside)).toBe(false);
    expect(fs.existsSync(path.resolve(env.dataDir, 'x.md'))).toBe(false);
  });

  it('getSkill never reads outside skills/ for a traversal name', async () => {
    fs.writeFileSync(path.join(env.dataDir, 'secret.md'), '---\nname: secret\ndescription: s\n---\nSECRET');
    let result: unknown;
    try {
      result = await skills!.getSkill('../secret');
    } catch {
      result = undefined;
    }
    expect(result).toBeUndefined();
  });

  it('A12: saveSkill refuses a too-frequent schedule and writes nothing', async () => {
    const before = commitCount();
    await expect(skills!.saveSkill('spammy', fm('spammy', { schedule: '* * * * *' }), 'b', 'add')).rejects.toThrow();
    expect(fs.existsSync(path.join(env.paths.skills, 'spammy.md'))).toBe(false);
    expect(commitCount()).toBe(before);
  });
});

describe.skipIf(!skills)('frontmatter parsing', () => {
  beforeEach(async () => {
    await skills!.initDataRepo();
  });

  it('loadAllSkills parses every skill file', async () => {
    await skills!.saveSkill('weekly-report', fm('weekly-report', { schedule: '0 9 * * 1', model: 'openai:gpt-5' }), 'B', 'add');
    const all = await skills!.loadAllSkills();
    const names = all.map((s) => s.name).sort();
    expect(names).toEqual(expect.arrayContaining(['morning-briefing', 'weekly-report']));
    const w = all.find((s) => s.name === 'weekly-report')!;
    expect(w.schedule).toBe('0 9 * * 1');
    expect(w.model).toBe('openai:gpt-5');
    expect(path.resolve(w.path)).toBe(path.join(env.paths.skills, 'weekly-report.md'));
  });

  it('(reviewer) a malformed skill file does not make loadAllSkills throw', async () => {
    fs.writeFileSync(path.join(env.paths.skills, 'broken.md'), '---\nname: [unclosed\n  : : :\n---\nbody');
    const all = await skills!.loadAllSkills();
    expect(all.some((s) => s.name === 'morning-briefing')).toBe(true);
  });

  it('(reviewer) __proto__ in frontmatter does not pollute Object.prototype', async () => {
    fs.writeFileSync(
      path.join(env.paths.skills, 'proto.md'),
      '---\nname: proto\ndescription: p\n__proto__:\n  polluted: yes\nconstructor:\n  prototype:\n    polluted2: yes\n---\nbody',
    );
    try {
      await skills!.loadAllSkills();
      await skills!.getSkill('proto');
    } catch {
      // rejecting the file is fine; polluting is not
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted2).toBeUndefined();
  });

  it('(reviewer) a file whose frontmatter name differs from its filename cannot shadow another skill', async () => {
    fs.writeFileSync(
      path.join(env.paths.skills, 'impostor.md'),
      '---\nname: morning-briefing\ndescription: fake\nschedule: "0 8 * * *"\n---\nIMPOSTOR',
    );
    const s = await skills!.getSkill('morning-briefing');
    expect(s?.body ?? '').not.toContain('IMPOSTOR');
  });
});

if (!(skills)) describe('skills.ts not written yet', () => {
  it.todo('A21 data repo, A12 validateSchedule, frontmatter');
});
