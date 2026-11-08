/**
 * Verify round 4 (docs/REVIEW.md).
 *
 * 1. Source hygiene: no file under src/ contains a raw invisible character
 *    (any \p{Cf}, any \p{Default_Ignorable_Code_Point}, or U+00A0/U+2028/U+2029).
 *    Our own source must not carry the Trojan Source characters that A26
 *    reveals in previews; write them as ASCII escapes instead.
 *    This file builds its pattern from String.raw and numeric code points, so it
 *    contains no raw invisible character itself (the last test checks that).
 *
 * 2. skills.ts BOM handling, through the public API (getSkill, loadAllSkills,
 *    assertBodyHasNoFence, saveSkill): the BOM regexes at skills.ts:288/:309
 *    were rewritten as escapes and had no test.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyEnv, setupTestEnv, type TestEnv } from './helpers/env.js';
import { assertBodyHasNoFence, getSkill, initDataRepo, loadAllSkills, saveSkill } from '../src/skills.js';

applyEnv();

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', 'src');
const BACKSLASH = String.fromCharCode(92);
const uEsc = (cp: number) => BACKSLASH + 'u' + cp.toString(16).toUpperCase().padStart(4, '0');
/** Cf, Default_Ignorable, U+00A0, U+2028 and U+2029; built without typing any escape the tooling could decode. */
const INVISIBLE = new RegExp(
  '[' + String.raw`\p{Cf}\p{Default_Ignorable_Code_Point}` + [0x00a0, 0x2028, 0x2029].map(uEsc).join('') + ']',
  'u',
);
const BOM = String.fromCharCode(0xfeff);

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
  );
}

function invisibleHits(file: string): string[] {
  const hits: string[] = [];
  fs.readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      for (const ch of line) {
        if (INVISIBLE.test(ch)) hits.push(`${path.relative(SRC, file)}:${i + 1} U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`);
      }
    });
  return hits;
}

describe('verify round 4: no raw invisible characters in src/', () => {
  it('the pattern catches what it should (and not ordinary text)', () => {
    for (const cp of [0x200b, 0x202e, 0xfeff, 0x00ad, 0x2066, 0x17b4, 0x180b, 0xfe0f, 0x3164, 0x00a0, 0x2028, 0x2029, 0xe0041]) {
      expect(INVISIBLE.test(String.fromCodePoint(cp)), cp.toString(16)).toBe(true);
    }
    for (const s of ['a', ' ', '\t', '⟨', '—', '😀', 'é']) expect(INVISIBLE.test(s), s).toBe(false);
  });

  it('every file under src/ is free of them', () => {
    const files = walk(SRC);
    expect(files.length).toBeGreaterThan(10);
    expect(files.flatMap(invisibleHits)).toEqual([]);
  });

  it('this test file itself contains none (the escapes above stayed ASCII)', () => {
    expect(invisibleHits(fileURLToPath(import.meta.url))).toEqual([]);
  });
});

describe('verify round 4: skills.ts BOM handling', () => {
  let env: TestEnv;
  beforeEach(async () => {
    env = await setupTestEnv({ db: false });
  });
  afterEach(async () => {
    await env.cleanup();
  });

  const writeSkillFile = (name: string, raw: string) => {
    fs.mkdirSync(env.paths.skills, { recursive: true });
    fs.writeFileSync(path.join(env.paths.skills, `${name}.md`), raw, 'utf8');
  };
  const FILE = '---\nname: bom-skill\ndescription: has a BOM\nschedule: "0 8 * * *"\nmodel: "openai:gpt-5"\n---\n## Objective\nDo it.\n';

  it('a skill file that starts with a BOM still parses its frontmatter (getSkill and loadAllSkills)', async () => {
    writeSkillFile('bom-skill', BOM + FILE);
    expect(fs.readFileSync(path.join(env.paths.skills, 'bom-skill.md'), 'utf8').charCodeAt(0)).toBe(0xfeff);
    const s = await getSkill('bom-skill');
    expect(s).toBeDefined();
    expect(s!.description).toBe('has a BOM');
    expect(s!.schedule).toBe('0 8 * * *');
    expect(s!.model).toBe('openai:gpt-5');
    expect(s!.body).toBe('## Objective\nDo it.\n');
    const all = await loadAllSkills();
    expect(all.map((x) => [x.name, x.schedule])).toEqual([['bom-skill', '0 8 * * *']]);
  });

  it('a BOM does not hide a ---js fence: the file is rejected and never evaluated', async () => {
    const marker = `__REVIEW_R4_bom_js_${Date.now()}`;
    writeSkillFile('bom-js', `${BOM}---js\n{ name: (globalThis.${marker} = true, 'x') }\n---\nbody\n`);
    await expect(getSkill('bom-js')).rejects.toThrow(/must be YAML|not allowed/);
    expect(await loadAllSkills()).toEqual([]); // skipped with a warning
    expect((globalThis as Record<string, unknown>)[marker]).toBeUndefined();
  });

  it('assertBodyHasNoFence rejects a body that starts with BOM + ---, with or without blank lines', () => {
    for (const body of [`${BOM}---\nschedule: "* * * * *"\n---\n`, `${BOM}\n\n  ---\nx`, `${BOM}---js\n{}\n---\n`]) {
      expect(() => assertBodyHasNoFence(body), JSON.stringify(body)).toThrow(/must not start with a "---" line/);
    }
    expect(() => assertBodyHasNoFence(`${BOM}## Objective\n---\n`)).not.toThrow(); // a later rule line is fine
  });

  it('saveSkill (the public write path) rejects a BOM + --- body and writes nothing', async () => {
    await initDataRepo();
    const file = path.join(env.paths.skills, 'bom-body.md');
    await expect(
      saveSkill('bom-body', { name: 'bom-body', description: 'd' }, `${BOM}---\nschedule: "* * * * *"\n---\n`, 'probe'),
    ).rejects.toThrow(/must not start with a "---" line/);
    expect(fs.existsSync(file)).toBe(false);
  });
});
