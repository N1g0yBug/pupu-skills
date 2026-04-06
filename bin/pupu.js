#!/usr/bin/env node

/**
 * pupu CLI entry point.
 *
 * Usage:
 *   pupu start          Start the MCP server on stdio (for Claude Code)
 *   pupu list           List all registered skills
 *   pupu show <name>    Show a skill's markdown content
 *   pupu history <name> Show recent execution history
 *   pupu delete <name>  Delete a user skill
 */

import { runCli } from "../dist/cli.js";

await runCli(process.argv.slice(2));
