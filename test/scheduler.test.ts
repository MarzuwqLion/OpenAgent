/**
 * scheduler.ts (Wave 2): A18 time zone, A19 reloads + overlap protection,
 * A20 follow-ups that survive restarts. croner is wrapped (not replaced) so
 * every job the scheduler creates is recorded.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Cron as CronType } from 'croner';
import { closeDb, createFollowup, getFollowup, getThread, initDb, listPendingFollowups, markFollowup } from '../src/db.js';
import { SCHEDULER_USER_ID } from '../src/types.js';
import { applyEnv, setupTestEnv, sleep, type TestEnv } from './helpers/env.js';
import { FakeSlackPort, fakeRunner } from './helpers/fakes.js';
import { loadSrc, type SchedulerModule, type SkillsModule } from './helpers/modules.js';

interface RecordedJob {
  pattern: unknown;
  options: Record<string, unknown> | undefined;
  hasFn: boolean;
  job: CronType;
}

const rec = vi.hoisted(() => ({ jobs: [] as unknown[] }));

vi.mock('croner', async (importOriginal) => {
  const real = await importOriginal<typeof import('croner')>();
  class RecordingCron extends real.Cron {
    constructor(pattern: string | Date, a?: unknown, b?: unknown) {
      super(pattern, a as never, b as never);
      const options = [a, b].find((x) => x !== null && typeof x === 'object') as Record<string, unknown> | undefined;
      rec.jobs.push({ pattern, options, hasFn: [a, b].some((x) => typeof x === 'function'), job: this });
    }
  }
  return { ...real, Cron: RecordingCron };
});

const jobs = () => rec.jobs as RecordedJob[];
const running = () => jobs().filter((j) => j.job.isRunning());

const SCHED_ENV = { TZ: 'America/New_York', SLACK_DEFAULT_CHANNEL: 'C0DEFAULT' };
applyEnv(SCHED_ENV);
const schedulerMod = await loadSrc<SchedulerModule>('scheduler.js');
const skills = await loadSrc<SkillsModule>('skills.js');
const ready = Boolean(schedulerMod && skills);

let env: TestEnv;
let stopFns: (() => void)[] = [];
beforeEach(async () => {
  rec.jobs.length = 0;
  env = await setupTestEnv({ env: SCHED_ENV });
  if (skills) await skills.initDataRepo();
});
afterEach(async () => {
  for (const s of stopFns) s();
  stopFns = [];
  for (const j of jobs()) j.job.stop();
  await env.cleanup();
});

function makeScheduler(impl?: Parameters<typeof fakeRunner>[0]) {
  const slack = new FakeSlackPort();
  const runner = fakeRunner(impl);
  const sched = schedulerMod!.createScheduler({ slack, runAgent: () => runner });
  stopFns.push(() => sched.stop());
  return { slack, runner, sched };
}

async function scheduledSkillCount(): Promise<number> {
  return (await skills!.loadAllSkills()).filter((s) => (s.schedule ?? '').trim() !== '').length;
}

describe.skipIf(!ready)('cron jobs (A18, A19)', () => {
  it('A18: every skill job gets the configured timezone', async () => {
    const { sched } = makeScheduler();
    await sched.start();
    expect(running().length).toBeGreaterThanOrEqual(1);
    for (const j of running()) expect(j.options?.timezone).toBe('America/New_York');
  });

  it('A19: jobs use overlap protection', async () => {
    const { sched } = makeScheduler();
    await sched.start();
    for (const j of running()) expect(j.options?.protect).toBeTruthy();
  });

  it('A19: reloading twice leaves exactly one job per scheduled skill', async () => {
    const { sched } = makeScheduler();
    await sched.start();
    const expected = await scheduledSkillCount();
    expect(running()).toHaveLength(expected);
    await sched.reloadSchedules();
    await sched.reloadSchedules();
    expect(running()).toHaveLength(expected);
  });

  it('A19: a reload picks up new skills and changed schedules, stopping the old job', async () => {
    const { sched } = makeScheduler();
    await sched.start();
    const mb = (await skills!.getSkill('morning-briefing'))!;
    const oldPattern = mb.schedule;
    await skills!.saveSkill('weekly-report', { name: 'weekly-report', description: 'w', schedule: '0 9 * * 1' }, 'B', 'add');
    await skills!.saveSkill('morning-briefing', { ...mb, schedule: '30 7 * * *' }, mb.body, 'move briefing');
    await sched.reloadSchedules();
    const patterns = running().map((j) => j.job.getPattern());
    expect(patterns).toContain('0 9 * * 1');
    expect(patterns).toContain('30 7 * * *');
    expect(patterns).not.toContain(oldPattern);
    expect(running()).toHaveLength(await scheduledSkillCount());
  });

  it('stop() stops every job', async () => {
    const { sched } = makeScheduler();
    await sched.start();
    sched.stop();
    expect(running()).toHaveLength(0);
  });

  it('a firing job posts to Slack, links the thread to the skill, and runs as the scheduler', async () => {
    const { sched, slack, runner } = makeScheduler();
    await sched.start();
    const mb = (await skills!.getSkill('morning-briefing'))!;
    const job = running().find((j) => j.job.getPattern() === mb.schedule);
    expect(job).toBeDefined();
    await job!.job.trigger();
    await expect.poll(() => runner.calls.length).toBe(1);
    const call = runner.calls[0]!;
    expect(call.userId).toBe(SCHEDULER_USER_ID);
    expect(call.skillName).toBe('morning-briefing');
    expect(slack.messages.some((m) => m.ts === call.threadTs)).toBe(true);
    expect(slack.messages[0]?.channel).toBe('C0DEFAULT');
    expect(getThread(call.threadTs)?.skillName).toBe('morning-briefing');
  });

  it('a skill whose frontmatter has an invalid schedule does not stop the others loading', async () => {
    // Written behind the API's back (e.g. a hand edit); start() must not throw.
    const fs = await import('node:fs');
    const path = await import('node:path');
    fs.writeFileSync(path.join(env.paths.skills, 'bad-cron.md'), '---\nname: bad-cron\ndescription: x\nschedule: "every day"\n---\nb');
    const { sched } = makeScheduler();
    await expect(sched.start()).resolves.toBeUndefined();
    expect(running().length).toBeGreaterThanOrEqual(1);
  });
});

describe.skipIf(!ready)('follow-ups (A20)', () => {
  it('scheduleFollowup persists a PENDING row and returns its id', async () => {
    const { sched } = makeScheduler();
    await sched.start();
    const id = await sched.scheduleFollowup({ threadTs: 't1', channelId: 'C1', runAt: Date.now() + 3_600_000, prompt: 'check the build' });
    const row = getFollowup(id);
    expect(row?.status).toBe('PENDING');
    expect(row?.prompt).toBe('check the build');
    expect(listPendingFollowups().map((f) => f.id)).toContain(id);
  });

  it('a pending follow-up is re-armed after a simulated restart and fires once', async () => {
    const f = createFollowup({ threadTs: '1700000000.000777', channelId: 'C1', runAt: Date.now() + 300, prompt: 'did the deploy finish?' });
    closeDb(); // simulated restart
    initDb(env.dbPath);
    const { sched, runner } = makeScheduler();
    await sched.start();
    await expect.poll(() => runner.calls.length, { timeout: 5_000 }).toBe(1);
    const call = runner.calls[0]!;
    expect(call.threadTs).toBe('1700000000.000777');
    expect(call.channelId).toBe('C1');
    expect(call.userId).toBe(SCHEDULER_USER_ID);
    expect(call.userMessage).toContain('did the deploy finish?');
    await expect.poll(() => getFollowup(f.id)?.status).toBe('DONE');
    await sleep(300);
    expect(runner.calls).toHaveLength(1);
  });

  it('an overdue follow-up fires on boot', async () => {
    const f = createFollowup({ threadTs: 't-over', channelId: 'C1', runAt: Date.now() - 60_000, prompt: 'overdue' });
    const { sched, runner } = makeScheduler();
    await sched.start();
    await expect.poll(() => runner.calls.length, { timeout: 5_000 }).toBe(1);
    await expect.poll(() => getFollowup(f.id)?.status).toBe('DONE');
  });

  it('cancelled or already-claimed follow-ups are not fired', async () => {
    const a = createFollowup({ threadTs: 't-a', channelId: 'C1', runAt: Date.now() - 1, prompt: 'a' });
    const b = createFollowup({ threadTs: 't-b', channelId: 'C1', runAt: Date.now() - 1, prompt: 'b' });
    markFollowup(a.id, 'CANCELLED');
    markFollowup(b.id, 'RUNNING');
    const { sched, runner } = makeScheduler();
    await sched.start();
    await sleep(400);
    expect(runner.calls).toHaveLength(0);
  });

  it('a failing follow-up is marked FAILED and does not crash the scheduler', async () => {
    const f = createFollowup({ threadTs: 't-fail', channelId: 'C1', runAt: Date.now() - 1, prompt: 'boom' });
    const { sched } = makeScheduler(() => {
      throw new Error('LLM down');
    });
    await sched.start();
    await expect.poll(() => getFollowup(f.id)?.status, { timeout: 5_000 }).toBe('FAILED');
  });

  // schedule_followup accepts up to 30 days; setTimeout fires at once beyond 2^31-1 ms (~24.8 days).
  it('a follow-up more than 24.8 days out does not fire immediately (setTimeout overflow)', async () => {
    const f = createFollowup({ threadTs: 't-far', channelId: 'C1', runAt: Date.now() + 30 * 24 * 3_600_000, prompt: 'far' });
    const { sched, runner } = makeScheduler();
    await sched.start();
    await sleep(500);
    expect(runner.calls).toHaveLength(0);
    expect(getFollowup(f.id)?.status).toBe('PENDING');
  });

  it('stop() disarms pending follow-up timers', async () => {
    createFollowup({ threadTs: 't-stop', channelId: 'C1', runAt: Date.now() + 300, prompt: 'x' });
    const { sched, runner } = makeScheduler();
    await sched.start();
    sched.stop();
    await sleep(600);
    expect(runner.calls).toHaveLength(0);
  });
});

if (!(ready)) describe('scheduler.ts not written yet (Wave 2)', () => {
  it.todo('A18 timezone, A19 reload/protect, A20 follow-up re-arm');
});
