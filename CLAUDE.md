# OpenAgent: Project Specification

A lightweight, always-on Slack agent: open source, self-hosted and model-agnostic.

> **Read with `docs/AMENDMENTS.md`.** It corrects gaps in this spec and wins wherever the two conflict.
> The main session coordinating the build follows `LEAD.md`. Subagents follow their own file in `.claude/agents/`.

## 1. Core Architecture & Philosophy

Build a persistent AI agent in TypeScript that runs 24/7 on a single Linux VM. It must support both `linux/amd64` and Oracle Cloud Ampere `linux/arm64`.

- **Zero-friction setup.** There are no custom JSON config DSLs:
  - Configuration lives entirely in `.env`.
  - Skills live in `./data/skills/*.md` with YAML frontmatter.
  - State lives in one SQLite file, `./data/agent.db`.
- **Slack-first via Socket Mode.** Uses `@slack/bolt` in Socket Mode: an outbound WebSocket only, with no inbound ports or public webhooks.
- **Dynamic model switching.** Uses the Vercel AI SDK's `createProviderRegistry`, so the user can switch models on the fly. Example IDs: `anthropic:claude-sonnet-4-5`, `openai:gpt-5`, `google:gemini-2.5-pro`, `openrouter:*`. The model can be set three ways:
  - Slack `/model`
  - natural language in a thread
  - per-skill frontmatter
- **Recursive learning loop.** Whenever the user critiques or gives feedback in a Slack thread, the agent updates `./data/MEMORY.md` or `./data/skills/<skill>.md`. It commits the diff to a local Git repo inside `./data` for version history and rollback.
- **Human-in-the-loop (HITL) approvals.** High-risk bash or browser actions pause execution, serialize state to SQLite, and render **Approve / Reject** Block Kit buttons in the active Slack thread.

## 2. Directory Structure

```text
.
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── slack-manifest.yaml
├── package.json
├── tsconfig.json
├── data/                        # Git-ignored host volume (persists across restarts)
│   ├── agent.db                 # SQLite database (WAL mode)
│   ├── MEMORY.md                # Global agent rules learned from user feedback
│   ├── skills/                  # Modular markdown SOPs with YAML frontmatter
│   │   └── morning-briefing.md  # Default example scheduled skill
│   ├── browser-profile/         # Persistent Playwright Chromium userDataDir
│   └── workspace/               # Sandboxed file/bash scratchpad for the agent
└── src/
    ├── index.ts                 # Entrypoint: boots DB, Git data repo, cron, and Slack Bolt
    ├── config.ts                # Zod-validated .env loader
    ├── db.ts                    # SQLite wrapper (better-sqlite3) and schema migrations
    ├── llm.ts                   # Vercel AI SDK createProviderRegistry + dynamic resolver
    ├── skills.ts                # Parses ./data/skills/*.md frontmatter + Git auto-commit
    ├── agent.ts                 # generateText loop (stopWhen: stepCountIs(15)) + prompt builder
    ├── scheduler.ts             # Croner job manager synced with skills and SQLite
    ├── slack.ts                 # @slack/bolt Socket Mode handlers (threads, DMs, /model, buttons)
    ├── doctor.ts                # CLI diagnostic tool (npm run doctor)
    └── tools/
        ├── index.ts             # Exports the unified toolset for generateText
        ├── bash.ts              # Runs shell commands in ./data/workspace (with HITL gate)
        ├── browser.ts           # Persistent Playwright Chromium tool (navigate, click, extract)
        ├── skills-memory.ts     # update_skill, create_skill, update_memory, revert_last_edit
        └── schedule-model.ts    # switch_model, schedule_followup
```

## 3. Tech Stack

Node.js 22+ and TypeScript with `strict: true`.

| Area | Packages |
|---|---|
| Core AI | `ai` (Vercel AI SDK), `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google`, `@openrouter/ai-sdk-provider`, `zod` |
| Slack | `@slack/bolt` |
| Database | `better-sqlite3`, `@types/better-sqlite3` |
| Scheduling & parsing | `croner`, `gray-matter` (YAML frontmatter in skill files) |
| Execution & browser | `playwright`, `execa` |
| Dev & CLI | `tsx`, `typescript`, `dotenv` |

## 4. Database Schema (`src/db.ts`)

SQLite at `./data/agent.db`:

```sql
PRAGMA journal_mode = WAL;

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL              -- stores default_model, seeded from process.env.DEFAULT_MODEL
);

CREATE TABLE threads (
  thread_ts      TEXT PRIMARY KEY, -- Slack thread timestamp
  channel_id     TEXT NOT NULL,
  skill_name     TEXT,             -- nullable; the skill that spawned this thread
  model_override TEXT,             -- nullable; provider:model for this thread
  messages_json  TEXT NOT NULL,    -- JSON array of CoreMessage objects
  updated_at     INTEGER NOT NULL
);

CREATE TABLE pending_approvals (
  id             TEXT PRIMARY KEY, -- UUID
  thread_ts      TEXT NOT NULL,
  channel_id     TEXT NOT NULL,
  tool_name      TEXT NOT NULL,
  tool_args_json TEXT NOT NULL,
  status         TEXT NOT NULL,    -- 'PENDING' | 'APPROVED' | 'REJECTED'
  created_at     INTEGER NOT NULL
);
```

## 5. Implementation Phases

### Phase 1: Scaffolding, config and SQLite layer

1. Initialize `package.json`, `tsconfig.json` and `.env.example`:
   ```env
   SLACK_BOT_TOKEN=xoxb-...
   SLACK_APP_TOKEN=xapp-...
   SLACK_DEFAULT_CHANNEL=C0123456789
   DEFAULT_MODEL=anthropic:claude-sonnet-4-5
   ANTHROPIC_API_KEY=
   OPENAI_API_KEY=
   GOOGLE_GENERATIVE_AI_API_KEY=
   OPENROUTER_API_KEY=
   ```
2. Write `src/config.ts`. It uses zod to require both Slack tokens and at least one LLM API key.
3. Write `src/db.ts` with typed helpers: `getThread`, `saveThread`, `setThreadModel`, `getGlobalModel`, `setGlobalModel`, `createApproval`, `resolveApproval`.

**Verification:** `npx tsc --noEmit` reports zero errors.

### Phase 2: Multi-provider registry (`src/llm.ts`)

- Register `anthropic`, `openai`, `google` and `openrouter` with `createProviderRegistry`. When `CUSTOM_BASE_URL` is set, also register a custom OpenAI-compatible provider.
- Write `resolveModel(threadTs?: string, skillModel?: string)` with strict precedence:
  1. `threads.model_override` (highest)
  2. the skill's frontmatter `model`
  3. `settings.default_model` (from SQLite)
  4. `env.DEFAULT_MODEL` (fallback)
- Export `listAvailableModels()`. It returns the configured providers, based on which API keys exist in `.env`.

**Verification:** `npx tsc --noEmit`.

### Phase 3: Skill files and Git audit trail (`src/skills.ts`)

- On startup, make sure `./data`, `./data/skills`, `./data/workspace` and `./data/browser-profile` exist.
- If `./data/.git` doesn't exist, run `git init` and commit the initial `MEMORY.md` and `skills/morning-briefing.md`.
- Skill file format, parsed with gray-matter:
  ```markdown
  ---
  name: morning-briefing
  description: Daily system and project briefing
  schedule: "0 8 * * *"
  channel: ""
  model: ""
  ---
  ## Objective
  Compile a concise morning report...

  ## Learned Rules & Corrections
  - Keep summaries under 150 words.
  ```
- Functions:
  - `loadAllSkills()`
  - `getSkill(name)`
  - `saveSkill(name, frontmatter, content, commitMessage)`
  - `appendMemoryRule(rule, commitMessage)`
  - `revertLastDataCommit()`
- Every write to `MEMORY.md` or `skills/*.md` runs `git add . && git commit -m "<commitMessage>"` inside `./data`.

**Verification:** a quick tsx script confirms frontmatter parsing and the automatic commits inside `./data`.

### Phase 4: Execution tools and HITL approval gate (`src/tools/`)

- **`bash.ts`**
  - Runs shell commands in `./data/workspace` via execa, with a 60s timeout.
  - A regex safety check catches destructive commands (`rm -rf`, `git push`, `sudo`, `curl -X POST`, `ssh`, etc.), or the call sets an explicit `requireApproval` flag.
  - When either triggers, the command does not run. Instead the tool:
    1. creates a `pending_approvals` row
    2. calls `slack.sendApprovalBlocks()`
    3. returns `PAUSED_FOR_USER_APPROVAL: Waiting for user to click Approve in Slack.`
- **`browser.ts`**
  - Lazy-loads a singleton `chromium.launchPersistentContext('./data/browser-profile', { headless: true })`.
  - Tools:
    - `browser_navigate`
    - `browser_extract_text`
    - `browser_click`
    - `browser_type`
    - `browser_screenshot`: saves to `./data/workspace` and uploads to the Slack thread
- **`skills-memory.ts`**
  - Tools: `update_skill`, `create_skill`, `update_global_memory`, `revert_skill_change`.
  - The system prompt must say: *"Whenever the user gives feedback, critiques an output, or states a preference in Slack, immediately call update_skill (if thread belongs to a skill) or update_global_memory to permanently record the rule, then confirm the commit hash to the user."*
- **`schedule-model.ts`**
  - `switch_model`: e.g. "use gemini-2.5-pro for this thread" or "set morning-briefing to use haiku".
  - `schedule_followup`: schedules a one-off delayed wake-up through `scheduler.ts`.

### Phase 5: Agent loop and cron scheduler (`src/agent.ts`, `src/scheduler.ts`)

`runAgentTurn({ threadTs, channelId, userMessage, skillName })`:
1. Load `MEMORY.md`, plus the skill's markdown body if the thread has a `skill_name`.
2. Build the system prompt: the active model ID, the available models, `MEMORY.md`, and the active skill's instructions.
3. Call `generateText` with `stopWhen: stepCountIs(15)` and the unified toolset.
4. Persist the updated messages to `threads.messages_json`.

Scheduler:
- Register a croner job for every skill in `./data/skills/*.md` with a non-empty `schedule`.
- `reloadSchedules()` hot-reloads the jobs when the agent edits a skill's cron expression or creates a skill from Slack. No container restart is needed.
- When a job fires:
  1. Post the initial message or final report to Slack.
  2. Save the returned `ts` as `thread_ts`, with `skill_name` set on that `threads` row.
  3. Later replies in that thread then know which skill file to update when the user gives feedback.

### Phase 6: Slack Socket Mode gateway and manifest (`src/slack.ts`, `slack-manifest.yaml`)

**Manifest:** Socket Mode enabled (`socket_mode_enabled: true`) and a `/model` slash command.
- Bot scopes: `app_mentions:read`, `channels:history`, `chat:write`, `commands`, `files:write`, `groups:history`, `im:history`, `im:read`, `im:write`.
- Bot events: `app_mention`, `message.channels`, `message.groups`, `message.im`.

**`slack.ts`** wires up `@slack/bolt`:
- Listens to DMs and thread replies (`event.thread_ts`). It looks up `thread_ts` in SQLite; if the thread exists, or the message is a DM, it routes to `runAgentTurn`.
- Adds `:hourglass_flowing_sand:` while processing. When done, it removes that and adds `:white_check_mark:`.
- `/model <provider:model>` switches the global default model and replies with the active status.
- Button actions `approve_tool_<id>` and `reject_tool_<id>`:
  1. Immediately `ack()`.
  2. Update the Slack message.
  3. If approved, run the command and append its output to the thread history.
  4. Resume `runAgentTurn`.

### Phase 7: Docker (arm64) and diagnostic doctor (`Dockerfile`, `src/doctor.ts`)

- **Base image:** `mcr.microsoft.com/playwright:v1.59.1-noble`. It is Ubuntu 24.04 LTS, multi-arch (amd64 and Oracle Ampere arm64), with Chromium preinstalled.
- **`docker-compose.yml`:** mounts `./data:/app/data`, loads `.env`, and sets `restart: unless-stopped`.
- **`npm run doctor`** (`src/doctor.ts`):
  - validates the `.env` keys
  - checks SQLite read/write permissions
  - test-launches headless Chromium
  - verifies Slack auth (`auth.test`)
  - prints a readiness summary
- **`README.md`:** a crisp 3-step quickstart for GitHub users.

## 6. Deployment: Free Oracle Cloud VM (about 10 minutes)

These are human steps; agents don't run them. The integration engineer copies them into `README.md`. Once the repo is generated and pushed to GitHub, this runs the agent 24/7 on Oracle Cloud for $0/month.

1. **Create the Oracle Cloud account and upgrade to Pay-As-You-Go ($0).**
   - Sign up at cloud.oracle.com.
   - Go to **Billing & Cost Management → Upgrade and Manage Payment** and switch to **Pay-As-You-Go**.
   - This unlocks commercial host capacity and stops idle-VM reclamation. The Always Free resources stay at $0.00/month.
2. **Provision one Ampere ARM64 instance.** Go to **Compute → Instances → Create Instance** and set:
   - **Image:** Ubuntu 24.04 LTS (Canonical), `aarch64`.
   - **Shape:** **Change Shape → Ampere (ARM64) → `VM.Standard.A1.Flex`**, with 2 OCPUs, 12 GB RAM and a 50 GB boot volume. That's well inside the free allowance.
   - **Networking:** keep every inbound port closed except 22 (SSH). Socket Mode needs no inbound web ports.
3. **Create the Slack app.**
   1. At [api.slack.com/apps](https://api.slack.com/apps), choose **Create New App → From a manifest**.
   2. Paste `slack-manifest.yaml` into the YAML tab, and install the app to your workspace.
   3. Copy the **App-Level Token** (`xapp-...`) and the **Bot User OAuth Token** (`xoxb-...`).
4. **Boot the agent on the VM.** SSH in and run:
   ```bash
   # Install Docker and Compose (Ubuntu 24.04 ARM64)
   curl -fsSL https://get.docker.com | sh
   sudo usermod -aG docker $USER && newgrp docker

   # Clone the repo and configure .env
   git clone https://github.com/<your-username>/<your-repo>.git
   cd <your-repo>
   cp .env.example .env
   nano .env   # paste your Slack tokens and LLM API keys

   # Launch in the background, 24/7
   docker compose up -d --build
   ```
