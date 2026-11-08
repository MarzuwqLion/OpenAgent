/**
 * A01: cross-module contracts (ports). Owned by the Lead.
 *
 * Only src/index.ts imports slack.ts and scheduler.ts; every other module
 * receives them through these ports, injected at boot. Changing a signature
 * here after Wave 0 requires notifying every affected owner.
 */

export interface ApprovalRequest {
  /** pending_approvals.id (UUID); used in the Slack action_id `approve_tool_<id>` / `reject_tool_<id>`. */
  id: string;
  /** The AI SDK's approval id (A03), from the `tool-approval-request` part. */
  approvalId: string;
  threadTs: string;
  channelId: string;
  toolName: string;
  /**
   * A26: the COMPLETE human-readable tool arguments — never truncated, since a
   * hidden tail is an approval bypass. At most APPROVAL_PREVIEW_MAX chars: the
   * agent auto-denies longer calls instead of asking. Slack renders all of it.
   */
  argsPreview: string;
}

/** A26: longest argsPreview a human is asked to approve; longer tool calls are denied automatically. */
export const APPROVAL_PREVIEW_MAX = 12_000;

export interface SlackPort {
  postMessage(channel: string, text: string, threadTs?: string): Promise<{ ts: string }>;
  uploadFile(channel: string, threadTs: string, filePath: string, title?: string): Promise<void>;
  postApprovalRequest(req: ApprovalRequest): Promise<void>;
}

export interface SchedulerPort {
  reloadSchedules(): Promise<void>;
  /** A20: persists a followups row, arms a timer, and returns the followup id. `runAt` is epoch ms. */
  scheduleFollowup(f: { threadTs: string; channelId: string; runAt: number; prompt: string }): Promise<string>;
}

export interface ToolContext {
  threadTs: string;
  channelId: string;
  /** Slack user who triggered the turn; `'scheduler'` for cron and follow-up turns. */
  userId: string;
  skillName?: string;
  slack: SlackPort;
  scheduler: SchedulerPort;
  /** A11: set to true by every browser_* tool; memory/skill writes then need approval. */
  turnState: { browserUsed: boolean };
}

export interface AgentTurnInput {
  threadTs: string;
  channelId: string;
  userId: string;
  userMessage?: string;
  skillName?: string;
  /** A03: resume a turn that stopped on a tool-approval request. */
  approvalResponse?: { approvalId: string; approved: boolean; reason?: string };
}

export interface AgentTurnResult {
  text: string;
  modelId: string;
  pendingApprovals: ApprovalRequest[];
}

export type AgentRunner = (input: AgentTurnInput) => Promise<AgentTurnResult>;

/** userId used for turns started by cron jobs and follow-ups rather than a person. */
export const SCHEDULER_USER_ID = 'scheduler';
