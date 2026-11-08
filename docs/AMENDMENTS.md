# OpenAgent Spec Amendments (binding)

These correct gaps in the blueprint in CLAUDE.md. **Where this file and CLAUDE.md disagree, this file wins.**

- Each amendment has an ID and an owner: `[LEAD]`, `[CORE]` (core-engineer), `[INTEG]` (integration-engineer).
- Mark the code that implements one with a comment like `// A07`. List the IDs you implemented in your report.
- The reviewer audits the code against this file.
- Only the Lead edits this file. To change an amendment, raise it in your report.

## Ground rules for every agent

- **The installed package is the source of truth.** Check its API in `node_modules/<pkg>` (types and README) before writing against it. That beats your memory and beats the spec. If what's installed differs from what this file says, follow what's installed and flag the difference in your report.
- **Model IDs go stale.** Check them against the provider's current docs at build time.

---

## Architecture

**A01 [LEAD] Contracts first.**
- `src/types.ts` defines the ports: `ToolContext`, `SlackPort`, `SchedulerPort`, `AgentRunner`, `ApprovalRequest`.
- Only `src/index.ts` imports `slack.ts` and `scheduler.ts`. Everything else receives them as ports, injected at boot.
- This breaks the spec's bash → slack → agent → tools import cycle.

**A02 [CORE] Tools are built per turn.**
- `createTools(ctx: ToolContext)` closes over the thread's `threadTs`, `channelId`, `skillName`, `userId` and the ports.
- Reason: an AI SDK tool's `execute()` has no idea which Slack thread it is running in.

**A03 [CORE+INTEG] Human approval uses the SDK's native tool approval.**
- When the installed `ai` package supports `needsApproval` (AI SDK 6+):
  - Gated tools declare `needsApproval` (a boolean or an async function).
  - `generateText` stops and returns tool-approval-request parts. `agent.ts` persists the messages, creates a `pending_approvals` row per request, and calls `slack.postApprovalRequest`.
  - On a button click, Integration calls `runAgentTurn({ approvalResponse })`. That appends the SDK's approval-response part and continues the turn. The SDK then runs the tool, or reports the denial to the model.
  - Check the exact part and field names in `node_modules/ai`.
- **Fallback, only if the installed SDK lacks native approval:** the tool returns `PAUSED_FOR_USER_APPROVAL` and stores its args. On approval, it executes and the output is appended as a new message. Never rewrite an earlier tool result.
- The system prompt says: "If a tool call is denied, do not retry it; tell the user it wasn't done."

**A04 [CORE] Message types.** Use the message type the installed SDK exports (`ModelMessage` in current versions; the spec's `CoreMessage` is the old name). `threads.messages_json` stores that type.

**A05 [LEAD+CORE] One turn at a time per thread.**
- `src/locks.ts` exports `withThreadLock(threadTs, fn)` and `withDataRepoLock(fn)`. Both are in-process async mutexes; one process is all we run.
- `runAgentTurn` takes the thread lock itself, so every caller (Slack, cron, follow-ups, approvals) is covered.
- Without it, two quick replies load the same history and the last write wins.

**A06 [CORE] Context budget.**
- Truncate any single tool result over 20,000 chars. Keep the head and tail with a `[truncated N chars]` marker.
- Cap the history at `HISTORY_MAX_MESSAGES` (default 120) by dropping the oldest messages.
- Never separate a tool call from its tool result; providers reject orphaned pairs.

## Security

**A07 [LEAD+INTEG] Access control.**
- `ALLOWED_SLACK_USER_IDS` is required (comma-separated).
- Messages, mentions and slash commands from anyone else are ignored.
- Button clicks from anyone else get an ephemeral "not authorized" and change nothing.
- Without this, anyone in the workspace can DM the bot and get a shell.

**A08 [CORE] Bash needs approval by default.** Drop the regex blocklist; it is trivially bypassed with `find -delete`, `python3 -c`, or base64 pipes.
- `BASH_APPROVAL_MODE=always` (default): every command needs approval.
- `BASH_APPROVAL_MODE=allowlist`: a command runs without approval only if both are true:
  - It contains no shell metacharacters (`` ; & | ` $ ( ) < > `` or a newline).
  - Its first word is one of: `ls cat head tail wc grep pwd date du df stat file`.
  - Anything else needs approval.

**A09 [CORE+INTEG] Bash can't touch the agent's own state.**
- Commands run as an unprivileged `sandbox` user (execa `uid`/`gid`).
- `/app/data/workspace` is owned by `sandbox`. Everything else in `/app/data` is mode 700 and owned by the app user.
- Otherwise `../agent.db` is one directory up and the agent could approve its own requests.
- To make the uid switch possible, the Node process runs as root inside the container.
- Test: as `sandbox`, reading `agent.db` and writing `MEMORY.md` must both fail.
- Known tradeoff: Chromium also runs as container root. That is acceptable on a dedicated VM as long as the only host mount is `./data`. The reviewer confirms there are no other mounts and no `privileged` flag.

**A10 [CORE] Scrub the environment.**
- Every child process gets `extendEnv: false` and a minimal env: `PATH`, `HOME=/app/data/workspace`, `LANG`, `TZ`.
- Otherwise `env` prints every API key and Slack token into the chat.

**A11 [CORE] Guard memory writes after browsing.**
- If any `browser_*` tool ran earlier in the current turn, then `update_global_memory`, `update_skill` and `create_skill` need approval (dynamic `needsApproval`). Track this in `ctx.turnState.browserUsed`.
- This stops a web page from injecting a permanent rule like "never ask for approval".

**A12 [CORE] Schedule guard.**
- Validate cron expressions with croner before saving.
- Reject anything that fires more often than every 15 minutes, to keep model costs bounded.

**A13 [INTEG+LEAD] Approvals are idempotent and expire.**
- Resolve with `UPDATE … WHERE id = ? AND status = 'PENDING'` and continue only if exactly one row changed. This prevents double execution on a double-click.
- Pending approvals older than 24 hours become `EXPIRED`.
- Update the Slack message to show who decided and when.

## Slack

**A14 [INTEG] Manifest additions.**
- Add the `reactions:write` scope.
- Set `features.app_home.messages_tab_enabled: true` and `messages_tab_read_only_enabled: false`. Without these, users can't DM the bot.
- Set `settings.interactivity.is_enabled: true`. Without it, buttons don't work.
- Check the field names against Slack's manifest reference.

**A15 [INTEG] Deduplicate events.**
- An @mention in a channel arrives twice, as `app_mention` and as `message.channels`.
- Keep an in-memory LRU cache of processed `channel:ts` keys.
- Skip message subtypes such as `message_changed`, `message_deleted` and `bot_message`.
- Keep Bolt's default `ignoreSelf`.

**A16 [INTEG] Format output for Slack.**
- Convert the model's Markdown to Slack mrkdwn, or use Slack's markdown block if the installed client supports it.
- Split replies longer than about 3,500 characters into multiple thread messages.

**A17 [INTEG] Reaction lifecycle.**
- Add :hourglass_flowing_sand: when a message arrives.
- On success, remove it and add :white_check_mark:.
- On error, add :x: and post a one-line error in the thread.

## Scheduler

**A18 [INTEG+LEAD] Time zone.**
- Add a `TZ` env var and pass it to croner's `timezone` option.
- Containers default to UTC, so an "8am" briefing would otherwise fire at 3 or 4am Eastern.

**A19 [INTEG] Reloads.**
- `reloadSchedules()` stops every existing job before registering new ones.
- Use croner's overlap protection so a slow run never overlaps itself.

**A20 [LEAD+INTEG+CORE] Follow-ups survive restarts.**
- New table: `followups(id, thread_ts, channel_id, run_at, prompt, status, created_at)`.
- `schedule_followup` writes a row; the scheduler re-arms pending rows on boot.
- The spec's in-memory timers die on every restart.

## Data repo

**A21 [CORE] The `./data` git repo.**
- Create `./data/.gitignore` containing `agent.db*`, `browser-profile/` and `workspace/`. The spec's `git add .` would otherwise commit the database and browser cookies into history.
- Stage only the files you changed.
- At init, set repo-local `user.name` and `user.email`.
- Add `/app/data` to git's `safe.directory`. The mounted volume's owner differs from the container user, which triggers "dubious ownership".
- Serialize every repo write with `withDataRepoLock` to avoid `index.lock` collisions.
- Revert affects only `./data`.

## Docker

**A22 [INTEG] Container.**
- The Playwright base image tag must equal the installed `playwright` version exactly (read it from `package-lock.json`).
- Compose sets `init: true` and `ipc: host` (or `shm_size: "1gb"`) for Chromium.
- Install `git` explicitly in the image.
- Build `better-sqlite3` inside the image. `.dockerignore` excludes `node_modules`, `data` and `.env`.
- Create the `sandbox` user. The entrypoint fixes ownership and permissions per A09.
- Verify arm64 with `docker buildx build --platform linux/arm64` before any VM deploy.

**A23 [LEAD] `.env.example` additions.**
- `DEFAULT_MODEL=anthropic:claude-sonnet-5-5` (verify it is still current)
- `ALLOWED_SLACK_USER_IDS=`
- `TZ=America/New_York`
- `BASH_APPROVAL_MODE=always`
- `HISTORY_MAX_MESSAGES=120`
- `CUSTOM_BASE_URL=` and `CUSTOM_API_KEY=`
