/**
 * Learning-loop tools: update_skill, create_skill, update_global_memory,
 * revert_skill_change. Each write commits to the ./data git repo and returns
 * the commit hash so the model can quote it.
 *
 * A11: these need approval whenever a browser_* tool ran earlier in the turn.
 * A12: schedules are validated before saving; the scheduler reloads after
 * any schedule change.
 */
import { tool, type ModelMessage } from 'ai';
import { z } from 'zod';
import { validateModelId } from '../llm.js';
import {
  appendMemoryRule,
  getSkill,
  revertLastDataCommit,
  saveSkill,
  SKILL_NAME_RE,
  validateSchedule,
  type SkillFrontmatter,
} from '../skills.js';
import type { ToolContext } from '../types.js';
import { errorMessage } from './util.js';

const LEARNED_HEADING = '## Learned Rules & Corrections';

/**
 * A11: true when any browser_* tool call appears after the last user message
 * in `messages`. Covers a turn resumed after an approval, where
 * ctx.turnState is fresh but earlier steps of the same turn used the browser.
 */
export function browserUsedInMessages(messages: readonly ModelMessage[] | undefined): boolean {
  if (!messages) return false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    if (m.role === 'user') return false;
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      if (m.content.some((p) => p.type === 'tool-call' && p.toolName.startsWith('browser_'))) return true;
    }
  }
  return false;
}

/** A11: dynamic needsApproval shared by every memory/skill write tool. */
export function memoryWriteNeedsApproval(ctx: ToolContext) {
  return (_input: unknown, options?: { messages?: ModelMessage[] }): boolean =>
    ctx.turnState.browserUsed || browserUsedInMessages(options?.messages);
}

/** Append `- rule` under the "Learned Rules & Corrections" heading (created if absent). */
export function addLearnedRule(body: string, rule: string): string {
  const line = `- ${rule.replace(/\s*\r?\n\s*/g, ' ').trim()}`;
  const lines = body.replace(/\s+$/, '').split('\n');
  const h = lines.findIndex((l) => l.trim().toLowerCase() === LEARNED_HEADING.toLowerCase());
  if (h === -1) return `${lines.join('\n')}\n\n${LEARNED_HEADING}\n${line}\n`;
  // Insert after the last line of that section (before the next heading).
  let end = h + 1;
  while (end < lines.length && !/^#{1,6}\s/.test(lines[end] ?? '')) end++;
  while (end > h + 1 && (lines[end - 1] ?? '').trim() === '') end--;
  lines.splice(end, 0, line);
  return `${lines.join('\n')}\n`;
}

function checkSchedule(schedule: string | undefined): string | undefined {
  if (schedule === undefined || schedule.trim() === '') return undefined;
  const v = validateSchedule(schedule);
  return v.ok ? undefined : v.reason;
}

function checkModel(model: string | undefined): string | undefined {
  if (model === undefined || model.trim() === '') return undefined;
  const v = validateModelId(model.trim());
  return v.ok ? undefined : v.reason;
}

async function reload(ctx: ToolContext): Promise<string> {
  try {
    await ctx.scheduler.reloadSchedules();
    return ' Schedules reloaded.';
  } catch (err) {
    return ` WARNING: schedule reload failed: ${errorMessage(err)}`;
  }
}

const skillName = z
  .string()
  .regex(SKILL_NAME_RE, 'lowercase letters, digits and dashes, e.g. morning-briefing')
  .describe('Skill name (file name without .md)');

export function createSkillMemoryTools(ctx: ToolContext) {
  const needsApproval = memoryWriteNeedsApproval(ctx);

  const update_skill = tool({
    description:
      'Update an existing skill file and commit it. Use `addRule` to record a learned rule or correction from user ' +
      'feedback (appended under "Learned Rules & Corrections"); use `body` only to rewrite the whole instructions. ' +
      'Set `schedule` to "" to unschedule. Returns the commit hash.',
    inputSchema: z.object({
      name: skillName,
      addRule: z.string().optional().describe('One rule/correction to append'),
      body: z.string().optional().describe('Full replacement markdown body (rarely needed)'),
      description: z.string().optional(),
      schedule: z.string().optional().describe('5-field cron, at least 15 minutes apart; "" to clear'),
      channel: z.string().optional().describe('Slack channel ID for scheduled runs; "" for the default'),
      model: z.string().optional().describe('provider:model for this skill; "" to clear'),
      commitMessage: z.string().describe('Short description of the change'),
    }),
    needsApproval,
    execute: async (input) => {
      const existing = await getSkill(input.name);
      if (!existing) return `Error: skill "${input.name}" does not exist. Use create_skill to create it.`;
      const problem = checkSchedule(input.schedule) ?? checkModel(input.model);
      if (problem) return `Error: ${problem}`;
      if (input.addRule === undefined && input.body === undefined && input.description === undefined &&
          input.schedule === undefined && input.channel === undefined && input.model === undefined) {
        return 'Error: nothing to change.';
      }

      let body = input.body ?? existing.body;
      if (input.addRule?.trim()) body = addLearnedRule(body, input.addRule);
      const fm: SkillFrontmatter = {
        name: existing.name,
        description: input.description ?? existing.description,
      };
      const schedule = input.schedule ?? existing.schedule;
      const channel = input.channel ?? existing.channel;
      const model = input.model?.trim() ?? existing.model;
      if (schedule !== undefined) fm.schedule = schedule.trim();
      if (channel !== undefined) fm.channel = channel.trim();
      if (model !== undefined) fm.model = model;

      const hash = await saveSkill(existing.name, fm, body, input.commitMessage);
      const scheduleChanged = (existing.schedule ?? '') !== (fm.schedule ?? '') ||
        (existing.channel ?? '') !== (fm.channel ?? '');
      const note = scheduleChanged ? await reload(ctx) : '';
      return `Updated skill "${existing.name}". Commit ${hash}.${note}`;
    },
  });

  const create_skill = tool({
    description:
      'Create a new skill (a markdown SOP with optional cron schedule) and commit it. Fails if it already exists. ' +
      'Returns the commit hash.',
    inputSchema: z.object({
      name: skillName,
      description: z.string(),
      body: z.string().describe('Markdown instructions, e.g. "## Objective ..." and "## Learned Rules & Corrections"'),
      schedule: z.string().optional().describe('5-field cron, at least 15 minutes apart (interpreted in the configured TZ)'),
      channel: z.string().optional().describe('Slack channel ID for scheduled runs; omit for the default channel'),
      model: z.string().optional().describe('provider:model to use for this skill'),
      commitMessage: z.string().optional(),
    }),
    needsApproval,
    execute: async (input) => {
      if (await getSkill(input.name)) return `Error: skill "${input.name}" already exists. Use update_skill instead.`;
      const problem = checkSchedule(input.schedule) ?? checkModel(input.model);
      if (problem) return `Error: ${problem}`;
      const fm: SkillFrontmatter = {
        name: input.name,
        description: input.description,
        schedule: input.schedule?.trim() ?? '',
        channel: input.channel?.trim() ?? '',
        model: input.model?.trim() ?? '',
      };
      const hash = await saveSkill(input.name, fm, input.body, input.commitMessage ?? `Create skill ${input.name}`);
      const note = fm.schedule ? await reload(ctx) : '';
      return `Created skill "${input.name}". Commit ${hash}.${note}`;
    },
  });

  const update_global_memory = tool({
    description:
      'Append a permanent global rule to MEMORY.md (applies to every thread) and commit it. Use for user ' +
      'preferences and corrections that are not specific to one skill. Returns the commit hash.',
    inputSchema: z.object({
      rule: z.string().describe('One concise rule, phrased as an instruction'),
      commitMessage: z.string().optional(),
    }),
    needsApproval,
    execute: async ({ rule, commitMessage }) => {
      if (rule.trim() === '') return 'Error: rule is empty.';
      const hash = await appendMemoryRule(rule, commitMessage ?? `Memory: ${rule.trim().slice(0, 60)}`);
      return `Recorded in MEMORY.md. Commit ${hash}.`;
    },
  });

  const revert_skill_change = tool({
    description:
      'Undo the most recent change to MEMORY.md or any skill by adding a git revert commit in the data repo. ' +
      'Returns the revert commit hash.',
    inputSchema: z.object({}),
    needsApproval,
    execute: async () => {
      try {
        const hash = await revertLastDataCommit();
        // A revert can change a schedule, so always reload.
        return `Reverted the last data change. Commit ${hash}.${await reload(ctx)}`;
      } catch (err) {
        return `Error: ${errorMessage(err)}`;
      }
    },
  });

  return { update_skill, create_skill, update_global_memory, revert_skill_change };
}
