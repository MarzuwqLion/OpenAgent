/**
 * Agent loop. Wave 1: only the A06 context-budget helpers, re-exported from
 * src/tools/util.ts (tools must not import this module; see the import-cycle
 * rule). createAgentRunner arrives in Wave 2.
 */
export { truncateToolResult, trimHistory } from './tools/util.js'; // A06
