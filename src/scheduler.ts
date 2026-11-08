/**
 * Scheduler: croner jobs for scheduled skills (A18, A19), persistent
 * follow-ups (A20) and the hourly approval sweep (A13). Owned by Integration.
 *
 * Only index.ts imports this file (A01); it must not import slack.ts.
 */
import { Cron } from 'croner';
import { webApi } from '@slack/bolt';
import { getConfig } from './config.js';
import {
  createFollowup,
  ensureThread,
  expireOldApprovals,
  getFollowup,
  listPendingFollowups,
  markFollowup,
} from './db.js';
import { getSkill, loadAllSkills, validateSchedule } from './skills.js';
import type { Skill } from './skills.js';
import { SCHEDULER_USER_ID } from './types.js';
import type { AgentRunner, SchedulerPort, SlackPort } from './types.js';

/** setTimeout fires immediately above 2^31-1 ms; re-arm in chunks well below that. */
export const MAX_TIMER_MS = 20 * 24 * 60 * 60 * 1000;
const APPROVAL_SWEEP_MS = 60 * 60 * 1000;

/** The "## Objective" section of a skill body, or the whole body when there is none. */
export function extractObjective(body: string): string {
  const m = /^##\s+Objective\s*\n([\s\S]*?)(?=^##\s|\s*$(?![\s\S]))/im.exec(body);
  const section = m?.[1]?.trim();
  return section && section !== '' ? section : body.trim();
}

function errLine(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/[A-Za-z0-9_\-.]{24,}/g, '[redacted]').replace(/\s+/g, ' ').slice(0, 160);
}

export function createScheduler(deps: {
  slack: SlackPort;
  runAgent: () => AgentRunner;
}): SchedulerPort & { start(): Promise<void>; stop(): void } {
  let jobs: Cron[] = [];
  const timers = new Map<string, NodeJS.Timeout>();
  let sweep: NodeJS.Timeout | undefined;
  let stopped = false;

  // ── Skill jobs ──
  async function runSkillJob(skillName: string, fallback: Skill): Promise<void> {
    const skill = (await getSkill(skillName)) ?? fallback; // pick up edits made since registration
    const channelId = skill.channel?.trim() || getConfig().SLACK_DEFAULT_CHANNEL;
    if (!channelId) {
      console.warn(`[scheduler] skill "${skillName}" has no channel and SLACK_DEFAULT_CHANNEL is unset; skipping`);
      return;
    }
    let threadTs: string | undefined;
    try {
      const header = await deps.slack.postMessage(channelId, `:alarm_clock: Running scheduled skill *${skillName}*`);
      threadTs = header.ts;
      ensureThread({ threadTs, channelId, skillName });
      const result = await deps.runAgent()({
        threadTs,
        channelId,
        userId: SCHEDULER_USER_ID,
        userMessage: extractObjective(skill.body),
        skillName,
      });
      if (result.text.trim() !== '') await deps.slack.postMessage(channelId, result.text, threadTs);
    } catch (err) {
      console.error(`[scheduler] skill "${skillName}" failed:`, errLine(err));
      if (threadTs) {
        await deps.slack
          .postMessage(channelId, `:x: Scheduled run of *${skillName}* failed: ${errLine(err)}`, threadTs)
          .catch(() => undefined);
      }
    }
  }

  async function reloadSchedules(): Promise<void> {
    // A19: stop everything before registering anything
    for (const j of jobs) j.stop();
    jobs = [];
    if (stopped) return;
    let skills: Skill[];
    try {
      skills = await loadAllSkills();
    } catch (err) {
      console.error('[scheduler] could not load skills:', errLine(err));
      return;
    }
    const tz = getConfig().TZ; // A18
    for (const skill of skills) {
      const pattern = (skill.schedule ?? '').trim();
      if (pattern === '') continue;
      const ok = validateSchedule(pattern);
      if (!ok.ok) {
        console.warn(`[scheduler] skill "${skill.name}" skipped: ${ok.reason}`);
        continue;
      }
      try {
        jobs.push(
          new Cron(pattern, { timezone: tz, protect: true, name: `skill:${skill.name}` }, () => runSkillJob(skill.name, skill)),
        );
      } catch (err) {
        console.warn(`[scheduler] skill "${skill.name}" skipped: ${errLine(err)}`);
      }
    }
  }

  // ── Follow-ups (A20) ──
  async function fireFollowup(id: string): Promise<void> {
    timers.delete(id);
    if (stopped) return;
    if (!markFollowup(id, 'RUNNING')) return; // claimed, cancelled or done: at-most-once
    const row = getFollowup(id);
    if (!row) return;
    try {
      ensureThread({ threadTs: row.threadTs, channelId: row.channelId });
      const result = await deps.runAgent()({
        threadTs: row.threadTs,
        channelId: row.channelId,
        userId: SCHEDULER_USER_ID,
        userMessage: `[Scheduled follow-up] ${row.prompt}`,
      });
      if (result.text.trim() !== '') await deps.slack.postMessage(row.channelId, result.text, row.threadTs);
      markFollowup(id, 'DONE');
    } catch (err) {
      console.error(`[scheduler] follow-up ${id} failed:`, errLine(err));
      markFollowup(id, 'FAILED');
      await deps.slack
        .postMessage(row.channelId, `:x: Scheduled follow-up failed: ${errLine(err)}`, row.threadTs)
        .catch(() => undefined);
    }
  }

  function arm(id: string, runAt: number): void {
    const existing = timers.get(id);
    if (existing) clearTimeout(existing);
    const delay = Math.max(0, runAt - Date.now());
    const timer =
      delay > MAX_TIMER_MS
        ? setTimeout(() => arm(id, runAt), MAX_TIMER_MS) // too far for one timer: re-arm
        : setTimeout(() => void fireFollowup(id), delay);
    timer.unref();
    timers.set(id, timer);
  }

  // ── Approval sweep (A13) ──
  let webClient: InstanceType<typeof webApi.WebClient> | undefined;
  async function sweepApprovals(): Promise<void> {
    try {
      const expired = expireOldApprovals();
      for (const row of expired) {
        if (!row.messageTs) continue;
        webClient ??= new webApi.WebClient(getConfig().SLACK_BOT_TOKEN);
        await webClient.chat
          .update({
            channel: row.channelId,
            ts: row.messageTs,
            text: `Expired: ${row.toolName} was not approved within 24 hours.`,
            blocks: [
              {
                type: 'section',
                text: { type: 'mrkdwn', text: `:hourglass: \`${row.toolName.replace(/`/g, '')}\` *Expired* (no decision within 24 hours)` },
              },
            ],
          })
          .catch((e: unknown) => console.warn('[scheduler] could not update expired approval:', errLine(e)));
      }
    } catch (err) {
      console.error('[scheduler] approval sweep failed:', errLine(err));
    }
  }

  return {
    reloadSchedules,

    async scheduleFollowup(f) {
      const row = createFollowup(f);
      if (!stopped) arm(row.id, row.runAt);
      return row.id;
    },

    async start() {
      stopped = false;
      await reloadSchedules();
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      for (const f of listPendingFollowups()) arm(f.id, f.runAt); // overdue rows fire at once
      await sweepApprovals();
      sweep ??= setInterval(() => void sweepApprovals(), APPROVAL_SWEEP_MS);
      sweep.unref();
    },

    stop() {
      stopped = true;
      for (const j of jobs) j.stop();
      jobs = [];
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      if (sweep) clearInterval(sweep);
      sweep = undefined;
    },
  };
}
