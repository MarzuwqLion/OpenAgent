/**
 * Entrypoint (Lead). Boot order (LEAD.md §3, Wave 2):
 *   config → initDataRepo → db → slack port → scheduler → agent runner → app.start() → scheduler.start()
 *
 * A01: this is the only module that imports slack.ts and scheduler.ts. Both
 * take `runAgent` as a getter, so they can exist before the runner that needs
 * their ports.
 */
import { createAgentRunner } from './agent.js';
import { ConfigError, configuredProviders, getConfig, type Config } from './config.js';
import { closeDb, initDb } from './db.js';
import { resolveModel } from './llm.js';
import { createScheduler } from './scheduler.js';
import { initDataRepo } from './skills.js';
import { createSlackApp } from './slack.js';
import { closeBrowser } from './tools/browser.js';
import type { AgentRunner } from './types.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

function describeError(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err);
}

function loadConfigOrExit(): Config {
  try {
    return getConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      console.error('Fix .env, then run `npm run doctor` (or `npm run doctor:prod` in the container) for a full readiness check.');
      process.exit(1);
    }
    throw err;
  }
}

async function main(): Promise<void> {
  const cfg = loadConfigOrExit();

  await initDataRepo();
  initDb();

  let runner: AgentRunner | undefined;
  const runAgent = (): AgentRunner => {
    if (!runner) throw new Error('agent runner not initialized yet');
    return runner;
  };

  const { app, port: slack } = createSlackApp({ runAgent });
  const scheduler = createScheduler({ slack, runAgent });
  runner = createAgentRunner({ slack, scheduler });

  await app.start();
  await scheduler.start();

  let modelId = cfg.DEFAULT_MODEL;
  try {
    modelId = resolveModel().modelId;
  } catch {
    // resolveModel already logged why; the env default is what we report.
  }
  console.log(
    `[openagent] connected via Socket Mode — model ${modelId}; providers ${configuredProviders(cfg).join(', ')}; ` +
      `TZ ${cfg.TZ}; bash approvals: ${cfg.BASH_APPROVAL_MODE}; allowed users: ${cfg.ALLOWED_SLACK_USER_IDS.length}`,
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[openagent] ${signal} received, shutting down`);
    const force = setTimeout(() => {
      console.error('[openagent] shutdown timed out; exiting');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    force.unref();

    scheduler.stop();
    await app.stop().catch((err: unknown) => console.error('[openagent] Slack disconnect failed:', describeError(err)));
    await closeBrowser().catch((err: unknown) => console.error('[openagent] browser close failed:', describeError(err)));
    closeDb();
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}

// A stray rejection from one Slack event must not take the agent down.
process.on('unhandledRejection', (reason) => {
  console.error('[openagent] unhandled promise rejection:', describeError(reason));
});
// State may be corrupt after an uncaught exception: exit and let `restart: unless-stopped` bring us back.
process.on('uncaughtException', (err) => {
  console.error('[openagent] uncaught exception, exiting:', describeError(err));
  process.exit(1);
});

main().catch((err: unknown) => {
  console.error('[openagent] fatal during startup:', describeError(err));
  process.exit(1);
});
