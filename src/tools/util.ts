/**
 * Shared helpers for tools and the agent loop.
 *
 * Lives under src/tools/ so tools never import agent.ts (agent.ts imports
 * tools/index.ts); agent.ts re-exports the A06 helpers from here.
 */

// ─── A06: context budget ────────────────────────────────────────────────

export const TOOL_RESULT_MAX_CHARS = 20_000;

/**
 * A06: cap a single tool result. Returns `text` unchanged when it fits;
 * otherwise keeps the head and tail around a `[truncated N chars]` marker,
 * where N is the number of characters removed. The result is at most
 * `max` + marker length (< 64) characters.
 */
export function truncateToolResult(text: string, max: number = TOOL_RESULT_MAX_CHARS): string {
  if (text.length <= max) return text;
  const keep = Math.max(0, Math.floor(max));
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  const removed = text.length - head - tail;
  return `${text.slice(0, head)}\n\n[truncated ${removed} chars]\n\n${tail > 0 ? text.slice(text.length - tail) : ''}`;
}

interface MessageLike {
  role?: unknown;
  content?: unknown;
}

interface PartLike {
  type?: unknown;
  toolCallId?: unknown;
  approvalId?: unknown;
}

function roleOf(m: unknown): unknown {
  return typeof m === 'object' && m !== null ? (m as MessageLike).role : undefined;
}

function partsOf(m: unknown): PartLike[] {
  if (typeof m !== 'object' || m === null) return [];
  const content = (m as MessageLike).content;
  if (!Array.isArray(content)) return [];
  return content.filter((p): p is PartLike => typeof p === 'object' && p !== null);
}

/** IDs a message introduces (tool calls, approval requests). */
function definedIds(m: unknown): { calls: string[]; approvals: string[] } {
  const calls: string[] = [];
  const approvals: string[] = [];
  for (const p of partsOf(m)) {
    if (p.type === 'tool-call' && typeof p.toolCallId === 'string') calls.push(p.toolCallId);
    if (p.type === 'tool-approval-request' && typeof p.approvalId === 'string') approvals.push(p.approvalId);
  }
  return { calls, approvals };
}

/** IDs a message refers back to (tool results, approval responses). */
function referencedIds(m: unknown): { calls: string[]; approvals: string[] } {
  const calls: string[] = [];
  const approvals: string[] = [];
  for (const p of partsOf(m)) {
    if (p.type === 'tool-result' && typeof p.toolCallId === 'string') calls.push(p.toolCallId);
    if (p.type === 'tool-approval-request' && typeof p.toolCallId === 'string') calls.push(p.toolCallId);
    if (p.type === 'tool-approval-response' && typeof p.approvalId === 'string') approvals.push(p.approvalId);
  }
  return { calls, approvals };
}

/**
 * A06: keep at most the newest `max` messages without orphaning tool pairs.
 *
 * The kept window is always a suffix of `messages`, so a kept tool call
 * never loses its (later) result. The window start moves forward until it
 * does not begin with a `role: 'tool'` message and every tool result /
 * approval response inside it refers to a tool call / approval request that
 * is also inside it. Returns the longest such suffix (possibly empty).
 */
export function trimHistory<T>(messages: T[], max: number): T[] {
  const limit = Math.max(0, Math.floor(max));
  if (messages.length <= limit && isSelfContained(messages, 0)) return messages.slice();

  // Walk backwards once, tracking IDs that are referenced but not yet defined
  // within the suffix [i, end). A start index is valid when nothing is dangling.
  const n = messages.length;
  const danglingCalls = new Set<string>();
  const danglingApprovals = new Set<string>();
  let best = n; // empty suffix is always valid
  const lowest = Math.max(0, n - limit);
  for (let i = n - 1; i >= lowest; i--) {
    const m = messages[i];
    const def = definedIds(m);
    for (const id of def.calls) danglingCalls.delete(id);
    for (const id of def.approvals) danglingApprovals.delete(id);
    const ref = referencedIds(m);
    // A message can reference IDs it defines itself (assistant approval
    // request pointing at its own tool call): only count IDs not defined here.
    for (const id of ref.calls) if (!def.calls.includes(id)) danglingCalls.add(id);
    for (const id of ref.approvals) if (!def.approvals.includes(id)) danglingApprovals.add(id);
    if (danglingCalls.size === 0 && danglingApprovals.size === 0 && roleOf(m) !== 'tool') best = i;
  }
  return messages.slice(best);
}

function isSelfContained(messages: unknown[], start: number): boolean {
  if (messages.length > start && roleOf(messages[start]) === 'tool') return false;
  const calls = new Set<string>();
  const approvals = new Set<string>();
  for (let i = start; i < messages.length; i++) {
    const m = messages[i];
    const def = definedIds(m);
    for (const id of def.calls) calls.add(id);
    for (const id of def.approvals) approvals.add(id);
    const ref = referencedIds(m);
    if (ref.calls.some((id) => !calls.has(id))) return false;
    if (ref.approvals.some((id) => !approvals.has(id))) return false;
  }
  return true;
}

// ─── Misc ───────────────────────────────────────────────────────────────

/** Minimal FIFO async mutex (not re-entrant). */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(fn: () => Promise<T> | T): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** One-line, length-capped rendering of tool args for logs and approval previews. */
export function previewArgs(args: unknown, max = 500): string {
  let s: string;
  try {
    s = typeof args === 'string' ? args : JSON.stringify(args);
  } catch {
    s = String(args);
  }
  s ??= String(args);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
