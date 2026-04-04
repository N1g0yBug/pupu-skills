#!/usr/bin/env node

/**
 * pupu CLI entry point.
 *
 * Usage:
 *   pupu start          Start the MCP server on stdio (for Claude Code)
 *   pupu start --sse    Start the MCP server with SSE transport
 *   pupu list           List all registered skills
 *   pupu run <name>     Execute a skill directly from the terminal
 */

import { runCli } from "../dist/cli.js";

await runCli(process.argv.slice(2));
