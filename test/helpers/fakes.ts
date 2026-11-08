/**
 * Recording fakes for the A01 ports.
 */
import type {
  AgentRunner,
  AgentTurnInput,
  AgentTurnResult,
  ApprovalRequest,
  SchedulerPort,
  SlackPort,
  ToolContext,
} from '../../src/types.js';

export class FakeSlackPort implements SlackPort {
  readonly messages: { channel: string; text: string; threadTs?: string; ts: string }[] = [];
  readonly uploads: { channel: string; threadTs: string; filePath: string; title?: string }[] = [];
  readonly approvals: ApprovalRequest[] = [];
  private seq = 0;

  nextTs(): string {
    this.seq += 1;
    return `1700000000.${String(this.seq).padStart(6, '0')}`;
  }

  async postMessage(channel: string, text: string, threadTs?: string): Promise<{ ts: string }> {
    const ts = this.nextTs();
    this.messages.push({ channel, text, ts, ...(threadTs !== undefined ? { threadTs } : {}) });
    return { ts };
  }

  async uploadFile(channel: string, threadTs: string, filePath: string, title?: string): Promise<void> {
    this.uploads.push({ channel, threadTs, filePath, ...(title !== undefined ? { title } : {}) });
  }

  async postApprovalRequest(req: ApprovalRequest): Promise<void> {
    this.approvals.push(req);
  }
}

export class FakeSchedulerPort implements SchedulerPort {
  reloads = 0;
  readonly followups: { id: string; threadTs: string; channelId: string; runAt: number; prompt: string }[] = [];

  async reloadSchedules(): Promise<void> {
    this.reloads += 1;
  }

  async scheduleFollowup(f: { threadTs: string; channelId: string; runAt: number; prompt: string }): Promise<string> {
    const id = `fu-${this.followups.length + 1}`;
    this.followups.push({ id, ...f });
    return id;
  }
}

export function makeToolContext(overrides: Partial<ToolContext> = {}): ToolContext & {
  slack: FakeSlackPort;
  scheduler: FakeSchedulerPort;
} {
  return {
    threadTs: '1700000000.000001',
    channelId: 'C0TEST',
    userId: 'U0ALLOWED1',
    slack: new FakeSlackPort(),
    scheduler: new FakeSchedulerPort(),
    turnState: { browserUsed: false },
    ...overrides,
  } as ToolContext & { slack: FakeSlackPort; scheduler: FakeSchedulerPort };
}

/** A recording AgentRunner for Slack/scheduler tests. */
export function fakeRunner(
  impl: (input: AgentTurnInput) => Promise<AgentTurnResult> | AgentTurnResult = () => ({
    text: 'fake reply',
    modelId: 'mock:mock-model',
    pendingApprovals: [],
  }),
): AgentRunner & { calls: AgentTurnInput[] } {
  const calls: AgentTurnInput[] = [];
  const fn = (async (input: AgentTurnInput) => {
    calls.push(input);
    return impl(input);
  }) as AgentRunner & { calls: AgentTurnInput[] };
  fn.calls = calls;
  return fn;
}
