/**
 * A02: the unified toolset, built per turn so every tool closes over the
 * thread's ToolContext (threadTs, channelId, skillName, userId, ports).
 *
 * Tools never import agent.ts (agent.ts imports this module).
 */
import type { ToolSet } from 'ai';
import type { ToolContext } from '../types.js';
import { createBashTool } from './bash.js';
import { createBrowserTools } from './browser.js';
import { createScheduleModelTools } from './schedule-model.js';
import { createSkillMemoryTools } from './skills-memory.js';

export function createTools(ctx: ToolContext) {
  const tools = {
    bash: createBashTool(ctx),
    ...createBrowserTools(ctx),
    ...createSkillMemoryTools(ctx),
    ...createScheduleModelTools(ctx),
  };
  return tools satisfies ToolSet;
}

export type AgentTools = ReturnType<typeof createTools>;

export { bashNeedsApproval, sandboxEnv } from './bash.js';
export { truncateToolResult, trimHistory } from './util.js';
