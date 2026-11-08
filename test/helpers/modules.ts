/**
 * Loads src modules that may not exist yet (they are written in parallel) and
 * types them by the PINNED contract, not by the implementation. A contract
 * mismatch therefore shows up as a failing assertion, not a tsc error in test/**.
 *
 * Missing file → null (the suite uses describe.skipIf). A file that exists but
 * throws on import is NOT swallowed: that is a real failure.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { App } from '@slack/bolt';
import type { AgentRunner, SchedulerPort, SlackPort, ToolContext } from '../../src/types.js';

export const SRC_DIR = path.resolve(import.meta.dirname, '../../src');

export function srcExists(rel: string): boolean {
  return fs.existsSync(path.join(SRC_DIR, rel.replace(/\.js$/, '.ts')));
}

export async function loadSrc<T>(rel: string): Promise<T | null> {
  const file = path.join(SRC_DIR, rel.replace(/\.js$/, '.ts'));
  if (!fs.existsSync(file)) return null;
  return (await import(pathToFileURL(file).href)) as T;
}

// ─── Pinned contracts ────────────────────────────────────────────────────

export type ValidationResult = { ok: true } | { ok: false; reason: string };

export interface LlmModule {
  resolveModel(
    threadTs?: string,
    skillModel?: string,
  ): { modelId: string; model: unknown } | Promise<{ modelId: string; model: unknown }>;
  listAvailableModels(): string[];
  validateModelId(id: string): ValidationResult;
}

export interface SkillFrontmatter {
  name: string;
  description: string;
  schedule?: string;
  channel?: string;
  model?: string;
}
export type Skill = SkillFrontmatter & { body: string; path: string };

export interface SkillsModule {
  initDataRepo(): Promise<void>;
  loadAllSkills(): Promise<Skill[]>;
  getSkill(name: string): Promise<Skill | undefined>;
  readMemory(): Promise<string>;
  saveSkill(name: string, frontmatter: SkillFrontmatter, content: string, commitMessage: string): Promise<string>;
  appendMemoryRule(rule: string, commitMessage: string): Promise<string>;
  revertLastDataCommit(): Promise<string>;
  validateSchedule(expr: string): ValidationResult;
}

export interface BashModule {
  bashNeedsApproval(cmd: string, mode: 'always' | 'allowlist'): boolean;
  sandboxEnv(): Record<string, string>;
}

/** Tool shape as seen from outside (ai's Tool, loosely typed). */
export interface LooseTool {
  description?: string;
  inputSchema?: unknown;
  needsApproval?: boolean | ((input: unknown, options: unknown) => boolean | PromiseLike<boolean>);
  execute?: (input: unknown, options: unknown) => unknown;
}

export interface ToolsModule {
  createTools(ctx: ToolContext): Record<string, LooseTool>;
}

export interface AgentModule {
  truncateToolResult(text: string, max?: number): string;
  trimHistory<T>(messages: T[], max: number): T[];
  createAgentRunner?: (deps: { slack: SlackPort; scheduler: SchedulerPort }) => AgentRunner;
}

export interface SlackModule {
  isAllowedUser(userId: string): boolean;
  createEventDeduper(): (key: string) => boolean;
  splitForSlack(text: string, limit?: number): string[];
  createSlackApp?: (deps: { runAgent: () => AgentRunner }) => { app: App; port: SlackPort };
}

export interface SchedulerModule {
  createScheduler(deps: {
    slack: SlackPort;
    runAgent: () => AgentRunner;
  }): SchedulerPort & { start(): Promise<void>; stop(): void };
}

/** Evaluate a tool's needsApproval exactly as the SDK would (boolean or function). */
export async function needsApproval(t: LooseTool | undefined, input: unknown): Promise<boolean> {
  if (!t) throw new Error('tool missing');
  const na = t.needsApproval;
  if (typeof na === 'function') return Boolean(await na(input, { toolCallId: 'x', messages: [], context: undefined }));
  return Boolean(na);
}

export async function executeTool(t: LooseTool | undefined, input: unknown): Promise<unknown> {
  if (!t?.execute) throw new Error('tool has no execute');
  return await t.execute(input, { toolCallId: 'x', messages: [], context: undefined });
}
