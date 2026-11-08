# OpenAgent: Lead Playbook (main session only)

> Subagents: this file isn't for you. Your instructions are in your own agent file and in `docs/AMENDMENTS.md`.

You are the Tech Lead. You build the foundation yourself, then coordinate three subagents:
- `core-engineer`
- `integration-engineer`
- `reviewer`

You own sequencing, contracts, dependencies, merges and gates. You do not write code inside another agent's files.

**Kickoff:** the user starts the session with: `Read LEAD.md and start Wave 0.`

Read `docs/AMENDMENTS.md` in full before Wave 0. It overrides CLAUDE.md wherever they conflict. It is deliberately *not* imported into CLAUDE.md, because CLAUDE.md is already long and every subagent reads AMENDMENTS explicitly.

---

## 1. Ownership (one owner per file)

| Owner | Files |
|---|---|
| **Lead** | `package.json`, `package-lock.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.env.example`, `src/config.ts`, `src/db.ts`, `src/types.ts`, `src/locks.ts`, `src/index.ts`, `docs/AMENDMENTS.md` |
| **core-engineer** | `src/llm.ts`, `src/agent.ts`, `src/skills.ts`, `src/tools/**` |
| **integration-engineer** | `src/slack.ts`, `src/scheduler.ts`, `src/doctor.ts`, `slack-manifest.yaml`, `Dockerfile`, `docker-compose.yml`, `.dockerignore`, `docker-entrypoint.sh`, `README.md` |
| **reviewer** | `test/**`, `docs/REVIEW.md` |

**Dependencies.** Only you run `npm install <pkg>`. Subagents request packages in their report, and you install them between waves. This prevents parallel agents from clobbering `package-lock.json`.

**After every subagent returns,** run `git status --porcelain` and check that every changed file is in that agent's row. If it touched someone else's file, revert that file and route the change to its owner.

## 2. Contracts you write in Wave 0 (`src/types.ts`, A01)

Keep these signatures stable. A change after Wave 0 means you notify every affected owner in their next delegation.

```ts
export interface ApprovalRequest {
  id: string;            // pending_approvals.id (UUID); used in Slack action_id
  approvalId: string;    // SDK approval id (A03)
  threadTs: string; channelId: string;
  toolName: string; argsPreview: string; // human-readable, truncated to 500 chars
}
export interface SlackPort {
  postMessage(channel: string, text: string, threadTs?: string): Promise<{ ts: string }>;
  uploadFile(channel: string, threadTs: string, filePath: string, title?: string): Promise<void>;
  postApprovalRequest(req: ApprovalRequest): Promise<void>;
}
export interface SchedulerPort {
  reloadSchedules(): Promise<void>;
  scheduleFollowup(f: { threadTs: string; channelId: string; runAt: number; prompt: string }): Promise<string>;
}
export interface ToolContext {
  threadTs: string; channelId: string; userId: string; skillName?: string;
  slack: SlackPort; scheduler: SchedulerPort;
  turnState: { browserUsed: boolean };            // A11
}
export interface AgentTurnInput {
  threadTs: string; channelId: string; userId: string;
  userMessage?: string; skillName?: string;
  approvalResponse?: { approvalId: string; approved: boolean; reason?: string }; // A03
}
export interface AgentTurnResult { text: string; modelId: string; pendingApprovals: ApprovalRequest[] }
export type AgentRunner = (input: AgentTurnInput) => Promise<AgentTurnResult>;
```

**Cross-boundary exports.** Owners must export exactly these names:

| File | Exports |
|---|---|
| `llm.ts` | `resolveModel(threadTs?, skillModel?)`, `listAvailableModels(): string[]`, `validateModelId(id): { ok: true } \| { ok: false; reason: string }` |
| `agent.ts` | `createAgentRunner(deps: { slack: SlackPort; scheduler: SchedulerPort }): AgentRunner` |
| `skills.ts` | `initDataRepo()`, `loadAllSkills()`, `getSkill(name)`, `saveSkill(...)`, `appendMemoryRule(...)` and `revertLastDataCommit()` (each write returns the commit hash) |
| `scheduler.ts` | `createScheduler(deps: { slack: SlackPort; runAgent: () => AgentRunner }): SchedulerPort & { start(): Promise<void>; stop(): void }` |
| `slack.ts` | `createSlackApp(deps: { runAgent: () => AgentRunner }): { app: App; port: SlackPort }` |

`slack.ts` and `scheduler.ts` take `runAgent` as a getter. This breaks the boot-order cycle: the agent runner needs the slack and scheduler ports, so those must exist before the runner does.

**Testable helpers.** These are pure functions the reviewer writes tests against in Wave 1, before the modules exist. Owners must export them under exactly these names:

| File | Helper | Amendment |
|---|---|---|
| `tools/bash.ts` | `bashNeedsApproval(cmd: string, mode: 'always' \| 'allowlist'): boolean` | A08 |
| `tools/bash.ts` | `sandboxEnv(): Record<string, string>` | A10 |
| `agent.ts` | `truncateToolResult(text: string, max?: number): string` | A06 |
| `agent.ts` | `trimHistory<T>(messages: T[], max: number): T[]` | A06 |
| `skills.ts` | `validateSchedule(expr: string): { ok: true } \| { ok: false; reason: string }` | A12 |
| `slack.ts` | `isAllowedUser(userId: string): boolean` | A07 |
| `slack.ts` | `createEventDeduper(): (key: string) => boolean` (true = first time seen) | A15 |
| `slack.ts` | `splitForSlack(text: string, limit?: number): string[]` | A16 |

**`db.ts` schema** is the spec's schema plus these changes:
- `pending_approvals` gains `approval_id`, `requested_by`, `decided_by`, `decided_at`. Status also allows `'EXPIRED'` (A13).
- New `followups` table (A20).

**`db.ts` helpers** are the spec's helpers plus:
- `createFollowup`, `listPendingFollowups`, `markFollowup`
- `getApproval`, `expireOldApprovals`
- `resolveApproval`, which returns `boolean` and is atomic per A13

## 3. Waves and gates

Commit at the end of every wave (`wave-N: summary`), so any wave can be rolled back. Subagents don't commit.

**Wave 0: you, alone**
1. Run `git init`. Write `.gitignore` (`node_modules`, `data/`, `.env`, `dist`).
2. Install the spec's packages, plus `vitest` and `@ai-sdk/openai-compatible`. Check the installed `ai` major version and note whether `needsApproval` exists (A03).
3. Write `tsconfig.json` (strict), `vitest.config.ts`, `.env.example` (A23), `config.ts` (also validates the A07 and A18 vars), `db.ts`, `types.ts` and `locks.ts`.
4. **Ask the user** for their Slack user ID(s) for `ALLOWED_SLACK_USER_IDS`. Subagents can't ask the user anything, so you collect everything human-only now.

- **Gate:** `npx tsc --noEmit` is clean, and a tsx smoke script creates the DB, writes and reads each table, and resolves an approval exactly once.

**Wave 1: three in parallel** (spawn all three in one message)
- **core-engineer:** `llm.ts`, `skills.ts`, `tools/**` (A02, A06, A08–A12, A21).
- **integration-engineer:** `Dockerfile`, `docker-compose.yml`, `.dockerignore`, `docker-entrypoint.sh`, `slack-manifest.yaml`, `doctor.ts` (A14, A22).
- **reviewer (test mode):** writes the suite from `types.ts`, the testable-helpers table and `AMENDMENTS.md`, using fakes and the SDK's mock model. Include both tables in the delegation, since the reviewer can't see this file's context otherwise. Integration tests for Wave 2 code may stay `todo`.

- **Gate:**
  - `tsc` is clean.
  - Unit tests for `llm` and `skills` pass.
  - `docker buildx build --platform linux/amd64,linux/arm64 .` succeeds.

**Wave 2: two in parallel**
- **core-engineer:** `agent.ts` (A03–A06).
- **integration-engineer:** `slack.ts`, `scheduler.ts` (A07, A13, A15–A20).

Then **you** write `index.ts`: config → `initDataRepo` → db → slack port → scheduler → agent runner → `app.start()` → `scheduler.start()`.

- **Gate:**
  - The full test suite passes.
  - `npm run doctor` is green with the user's real tokens.
  - The user completes the smoke test in section 5.

**Wave 3: review and fix**
1. **reviewer (audit mode)** writes `docs/REVIEW.md`.
2. You route each Critical or High finding to its file owner, citing the finding ID.
3. The reviewer re-verifies only those findings.

- **Gate:** zero open Critical or High findings. Then deploy to the Oracle VM using the checklist in CLAUDE.md.

## 4. Delegation template

Subagents start with no chat history. Each delegation must carry everything they need:

```
WAVE: <n>   ROLE MODE: <build | test | audit | fix>
FILES (yours to edit): <list>
AMENDMENTS IN SCOPE: <A-ids>
CONTEXT: <decisions made since Wave 0, e.g. "ai@6.x installed, native approval available">
INPUTS READY: <files from other owners you can import/read>
DONE WHEN: <exact commands that must pass>
FINDINGS TO FIX (fix mode only): <REVIEW.md ids>
```

## 5. Human smoke test (user runs this in Slack; agents can't)

1. DM the bot. You get a single reply, with the hourglass reaction swapping to a check.
2. @mention it in a channel. You get exactly one reply (A15).
3. Run `/model` with no args to see the status. Then set an invalid model ID and confirm it is rejected.
4. Ask it to run `ls`. You see Approve/Reject buttons. Approve: it runs once. Double-click: nothing happens twice.
5. Ask for another command and Reject it. The bot says it wasn't done and doesn't retry.
6. Have a second workspace user DM the bot and click Approve. Both are ignored or refused (A07).
7. Give feedback in a skill thread. It replies with a commit hash. Ask it to revert, and the revert works.
8. Set a skill schedule a few minutes out. It fires at the right local time (A18).
9. Restart the container while a follow-up is pending. The follow-up still fires (A20).
10. Ask it to run `env`, then approve. The output contains no keys or tokens (A10).
