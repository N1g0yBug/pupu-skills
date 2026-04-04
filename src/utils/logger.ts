/**
 * Lightweight logger — always writes to stderr.
 *
 * CRITICAL: stdout is reserved for MCP JSON-RPC protocol messages.
 * Any accidental write to stdout will corrupt the transport layer.
 */

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  SILENT = 4,
}

let currentLevel: LogLevel = LogLevel.INFO;

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

function timestamp(): string {
  return new Date().toISOString();
}

function formatMsg(level: string, msg: string, meta?: Record<string, unknown>): string {
  const base = `[${timestamp()}] [${level}] ${msg}`;
  if (meta && Object.keys(meta).length > 0) {
    return `${base} ${JSON.stringify(meta)}`;
  }
  return base;
}

export const logger = {
  debug(msg: string, meta?: Record<string, unknown>): void {
    if (currentLevel <= LogLevel.DEBUG) {
      process.stderr.write(formatMsg("DEBUG", msg, meta) + "\n");
    }
  },

  info(msg: string, meta?: Record<string, unknown>): void {
    if (currentLevel <= LogLevel.INFO) {
      process.stderr.write(formatMsg("INFO", msg, meta) + "\n");
    }
  },

  warn(msg: string, meta?: Record<string, unknown>): void {
    if (currentLevel <= LogLevel.WARN) {
      process.stderr.write(formatMsg("WARN", msg, meta) + "\n");
    }
  },

  error(msg: string, meta?: Record<string, unknown>): void {
    if (currentLevel <= LogLevel.ERROR) {
      process.stderr.write(formatMsg("ERROR", msg, meta) + "\n");
    }
  },
};
