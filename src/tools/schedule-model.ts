/**
 * switch_model and schedule_followup.
 *
 * switch_model always validates the ID first. Scopes: this thread
 * (threads.model_override), a named skill (frontmatter, committed), or the
 * global default (same as /model).
 * schedule_followup persists through ctx.scheduler.scheduleFollowup (A20).
 */
import { tool } from 'ai';
import { z } from 'zod';
import { ensureThread, setGlobalModel, setThreadModel } from '../db.js';
import { listAvailableModels, validateModelId } from '../llm.js';
import { getSkill, saveSkill, SKILL_NAME_RE } from '../skills.js';
import { SCHEDULER_USER_ID, type ToolContext } from '../types.js';
import { memoryWriteNeedsApproval } from './skills-memory.js';

const MIN_DELAY_MS = 60_000;
/** Follow-ups started by cron/follow-up turns must wait at least this long (A12 spirit: bounded cost). */
const MIN_SCHEDULER_DELAY_MS = 15 * 60_000;
const MAX_DELAY_MS = 30 * 24 * 60 * 60_000;

export function createScheduleModelTools(ctx: ToolContext) {
  // A11 (extended): after browsing, persistent changes a page could have authored need approval.
  const afterBrowsing = memoryWriteNeedsApproval(ctx);

  const switch_model = tool({
    description:
      'Switch the LLM. scope "thread" = this Slack thread from the next message on; scope "skill" = a named skill ' +
      '(edits its frontmatter and commits); scope "global" = the default for all threads (like /model). ' +
      'modelId must be a full provider:model ID, e.g. google:gemini-2.5-pro. Pass "" to clear a thread or skill override.',
    inputSchema: z.object({
      modelId: z.string(),
      scope: z.enum(['thread', 'skill', 'global']),
      skillName: z.string().regex(SKILL_NAME_RE).optional().describe('Required when scope is "skill"'),
    }),
    // Thread scope only affects this conversation; skill/global scopes persist.
    needsApproval: (input, options) => input.scope !== 'thread' && afterBrowsing(input, options),
    execute: async ({ modelId, scope, skillName }) => {
      const id = modelId.trim();
      const clearing = id === '' && scope !== 'global';
      if (!clearing) {
        const v = validateModelId(id);
        if (!v.ok) return `Error: ${v.reason}. Available: ${listAvailableModels().join(', ')}`;
      }

      if (scope === 'thread') {
        ensureThread({ threadTs: ctx.threadTs, channelId: ctx.channelId, skillName: ctx.skillName ?? null });
        setThreadModel(ctx.threadTs, clearing ? null : id);
        return clearing
          ? 'Cleared this thread\'s model override; it falls back to the skill/global default from the next message.'
          : `This thread now uses ${id}, starting with the next message.`;
      }

      if (scope === 'global') {
        setGlobalModel(id);
        return `Global default model set to ${id}. Threads with their own override keep it.`;
      }

      const name = skillName ?? ctx.skillName;
      if (!name) return 'Error: scope "skill" needs skillName (this thread is not linked to a skill).';
      const skill = await getSkill(name);
      if (!skill) return `Error: skill "${name}" does not exist.`;
      const { body, path: _path, ...fm } = skill;
      const hash = await saveSkill(
        name,
        { ...fm, model: clearing ? '' : id },
        body,
        clearing ? `Clear model for skill ${name}` : `Set skill ${name} model to ${id}`,
      );
      return clearing
        ? `Skill "${name}" now uses the default model. Commit ${hash}.`
        : `Skill "${name}" now uses ${id}. Commit ${hash}.`;
    },
  });

  const schedule_followup = tool({
    description:
      'Schedule a one-off wake-up in this thread: after the delay the agent is run again with `prompt` as the ' +
      'instruction. Survives restarts. Give either delayMinutes or an ISO-8601 time `at`.',
    inputSchema: z.object({
      prompt: z.string().describe('What to do when the follow-up fires, written as an instruction to yourself'),
      delayMinutes: z.number().positive().optional(),
      at: z.string().optional().describe('ISO-8601 timestamp with offset, e.g. 2026-11-08T09:00:00-05:00'),
    }),
    // A follow-up is a persisted future turn whose prompt a page could author.
    needsApproval: afterBrowsing,
    execute: async ({ prompt, delayMinutes, at }) => {
      if (prompt.trim() === '') return 'Error: prompt is empty.';
      const now = Date.now();
      let runAt: number;
      if (at !== undefined) {
        runAt = Date.parse(at);
        if (Number.isNaN(runAt)) return `Error: could not parse time "${at}".`;
      } else if (delayMinutes !== undefined) {
        runAt = now + Math.round(delayMinutes * 60_000);
      } else {
        return 'Error: give delayMinutes or at.';
      }
      const minDelay = ctx.userId === SCHEDULER_USER_ID ? MIN_SCHEDULER_DELAY_MS : MIN_DELAY_MS;
      if (runAt - now < minDelay) return `Error: follow-ups must be at least ${minDelay / 60_000} minute(s) away.`;
      if (runAt - now > MAX_DELAY_MS) return 'Error: follow-ups can be at most 30 days away.';

      const id = await ctx.scheduler.scheduleFollowup({
        threadTs: ctx.threadTs,
        channelId: ctx.channelId,
        runAt,
        prompt: prompt.trim(),
      });
      return `Follow-up ${id} scheduled for ${new Date(runAt).toISOString()}.`;
    },
  });

  return { switch_model, schedule_followup };
}
