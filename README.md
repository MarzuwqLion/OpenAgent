# OpenAgent

A lightweight, always-on Slack agent. Self-hosted, model-agnostic, no inbound ports (Slack Socket Mode). It runs on one small Linux VM (amd64 or arm64), keeps its state in one SQLite file, and learns from your feedback by editing markdown files that it commits to a local git repo.

## Quickstart

1. **Create the Slack app.** At [api.slack.com/apps](https://api.slack.com/apps) choose **Create New App → From a manifest**, paste [`slack-manifest.yaml`](slack-manifest.yaml) into the YAML tab, and install it to your workspace.
   - **Bot token (`xoxb-...`):** **OAuth & Permissions → Bot User OAuth Token**, available after you install the app.
   - **App-level token (`xapp-...`):** **Basic Information → App-Level Tokens → Generate Token**, with the `connections:write` scope.
   - **Your member ID:** in Slack, open your profile, choose **⋯ → Copy member ID**.
2. **Configure.**
   ```bash
   cp .env.example .env
   # edit .env: SLACK_BOT_TOKEN, SLACK_APP_TOKEN, ALLOWED_SLACK_USER_IDS,
   # at least one LLM API key, and TZ (e.g. America/New_York)
   ```
3. **Run.**
   ```bash
   docker compose up -d --build
   docker compose exec openagent npm run doctor:prod   # optional health check
   ```
   Then DM the bot, or `@mention` it in a channel (invite it first).

The image is based on the Playwright image and runs **Node 26**. Everything persistent lives in `./data` (mounted into the container): `agent.db`, `MEMORY.md`, `skills/`, `browser-profile/`, `workspace/`.

### Model providers

Set at least one key in `.env`. Models are addressed as `provider:model`, and `DEFAULT_MODEL` must use a configured provider.

| Provider | Env var | Example ID |
|---|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` | `anthropic:claude-sonnet-5-5` |
| `openai` | `OPENAI_API_KEY` | `openai:gpt-5` |
| `google` | `GOOGLE_GENERATIVE_AI_API_KEY` | `google:gemini-2.5-pro` |
| `openrouter` | `OPENROUTER_API_KEY` | `openrouter:<vendor>/<model>` |
| `deepseek` | `DEEPSEEK_API_KEY` | `deepseek:deepseek-v4-pro` |
| `xai` (Grok) | `XAI_API_KEY` (alias `GROK_API_KEY`) | `xai:grok-4.7` |
| `custom` | `CUSTOM_BASE_URL` (+ optional `CUSTOM_API_KEY`) | `custom:<model>` (any OpenAI-compatible endpoint) |

Model names change often; check each provider's docs for current IDs.

### Health check

`npm run doctor` (locally) or `docker compose exec openagent npm run doctor:prod` prints one pass/fail line per check and exits non-zero if any fail:

- `.env` validation, `TZ` and `ALLOWED_SLACK_USER_IDS`
- SQLite read/write
- `git` and the `./data` repo
- headless Chromium launch
- Slack `auth.test` (bot token) and `apps.connections.open` (app token)
- inside the container: the sandbox isolation check

### Using it

- **Talk to it:** DM it, or `@mention` it in a channel. Replies in the thread continue the conversation.
- **Switch models:** `/model` shows the active model and the available ones; `/model openai:gpt-5` switches the global default. You can also ask in a thread ("use gemini-2.5-pro for this thread").
- **Skills:** markdown files in `./data/skills/*.md` with YAML frontmatter (`name`, `description`, `schedule`, `channel`, `model`). A skill with a cron `schedule` runs on time (in your `TZ`) and posts a thread you can reply to with feedback. Feedback becomes a committed edit to the skill or to `MEMORY.md`; ask the agent to revert if it got it wrong.
- **Follow-ups:** the agent can schedule a one-off wake-up in a thread (up to 30 days). Follow-ups survive restarts.

## Security model

**Who can talk to the bot.** Only the Slack members listed in `ALLOWED_SLACK_USER_IDS` (required). Messages, @mentions and `/model` from anyone else are ignored. A button click from anyone else gets an ephemeral "not authorized" and changes nothing.

**Approvals.** Risky actions stop and post **Approve / Reject** buttons in the thread. Approvals are one-shot (a double click can't run a tool twice) and expire after 24 hours. The message is updated to show who decided and when.

- **Bash:** `BASH_APPROVAL_MODE=always` (default) requires approval for every command. `allowlist` lets a single simple read-only command (`ls cat head tail wc grep pwd date du df stat file`, with no shell metacharacters) run without approval; everything else still asks.
- **After browsing:** once a turn has used any browser tool, writing memory or skills, switching the model for a skill or globally, and scheduling a follow-up all need approval. This stops a web page from injecting a permanent rule.
- **Typing into web pages:** `browser_type` always needs approval, and the preview shows the URL, the selector and the text. Navigating, clicking, extracting and screenshots don't.
- Skill schedules are validated and can't fire more often than every 15 minutes.

**What the sandbox can and can't touch.**

- Bash commands run as an unprivileged `sandbox` user in `./data/workspace`. That is the only directory the sandbox can read or write; `agent.db`, `MEMORY.md`, skills and the browser profile are mode 700 and owned by the app user, so a command can't edit its own approvals or rules.
- Child processes get a scrubbed environment (`PATH`, `HOME`, `LANG`, `TZ` only), so `env` doesn't print API keys or Slack tokens.
- Known tradeoff: the Node process and Chromium run as root inside the container. Run this on a dedicated VM, keep `./data` as the only host mount, and don't add `privileged: true`.
- The agent's own file writes (memory, skills) are committed to the git repo in `./data`, so every learned change can be reviewed or rolled back. The database and browser profile are git-ignored.
- Bash and Chromium have normal outbound network access. Approve commands accordingly.

## Deploy on a free Oracle Cloud VM (about 10 minutes, $0/month)

1. **Create the Oracle Cloud account and upgrade to Pay-As-You-Go ($0).**
   - Sign up at cloud.oracle.com.
   - Go to **Billing & Cost Management → Upgrade and Manage Payment** and switch to **Pay-As-You-Go**.
   - This unlocks commercial host capacity and stops idle-VM reclamation. The Always Free resources stay at $0.00/month.
2. **Provision one Ampere ARM64 instance.** Go to **Compute → Instances → Create Instance** and set:
   - **Image:** Ubuntu 24.04 LTS (Canonical), `aarch64`.
   - **Shape:** **Change Shape → Ampere (ARM64) → `VM.Standard.A1.Flex`**, with 2 OCPUs, 12 GB RAM and a 50 GB boot volume. That's well inside the free allowance.
   - **Networking:** keep every inbound port closed except 22 (SSH). Socket Mode needs no inbound web ports.
3. **Create the Slack app** (quickstart step 1 above) and copy the App-Level Token (`xapp-...`) and Bot User OAuth Token (`xoxb-...`).
4. **Boot the agent on the VM.** SSH in and run:
   ```bash
   # Install Docker and Compose (Ubuntu 24.04 ARM64)
   curl -fsSL https://get.docker.com | sh
   sudo usermod -aG docker $USER && newgrp docker

   # Clone the repo and configure .env
   git clone https://github.com/<your-username>/<your-repo>.git
   cd <your-repo>
   cp .env.example .env
   nano .env   # paste your Slack tokens, ALLOWED_SLACK_USER_IDS, TZ and LLM API keys

   # Launch in the background, 24/7
   docker compose up -d --build
   ```

## Development

```bash
npm ci
npm run typecheck
npm test
npm run doctor
npm run dev
```

Requires Node 22+ locally; the container image runs Node 26. Slack, scheduler and agent code are wired together only in `src/index.ts`; the other modules receive each other as ports (`src/types.ts`).
