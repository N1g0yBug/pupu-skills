/**
 * pupu CLI — 命令行入口。
 */

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { startMcpServer } from "./index.js";
import { SkillStore, type ExecutionRecord } from "./memory/store.js";

type CliArgs = string[];

function printUsage(): void {
  output.write(
    [
      "pupu-skills — Claude Code 技能管理 CLI",
      "",
      "用法:",
      "  pupu start            启动 MCP Server",
      "  pupu list             列出所有技能",
      "  pupu show <name>      查看技能 Markdown 内容",
      "  pupu history <name>   查看最近 10 条执行记录",
      "  pupu delete <name>    删除技能",
      "",
    ].join("\n")
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatHistoryRecord(record: ExecutionRecord): string {
  const status = record.success ? "成功" : "失败";
  const lines = [
    `- ${record.timestamp} | ${status} | ${formatDuration(record.duration)}`,
  ];

  if (record.summary.trim()) {
    lines.push(`  摘要: ${record.summary.trim()}`);
  }
  if (!record.success && record.error?.trim()) {
    lines.push(`  错误: ${record.error.trim()}`);
  }
  if (record.context.trim()) {
    lines.push(`  上下文: ${record.context.trim()}`);
  }

  return lines.join("\n");
}

async function confirmDelete(name: string): Promise<boolean> {
  if (!input.isTTY) {
    output.write("当前不是交互式终端，已取消删除。\n");
    return false;
  }

  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(`确认删除技能 "${name}"？输入 y 继续: `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

async function handleList(): Promise<void> {
  const store = await SkillStore.create();
  const skills = store.list();

  if (skills.length === 0) {
    output.write("技能库为空。\n");
    return;
  }

  for (const skill of skills) {
    output.write(
      [
        `${skill.name}${skill.builtin ? " [内置]" : ""}`,
        `  描述: ${skill.description || "(无)"}`,
        `  效用分: ${skill.utilityScore}`,
      ].join("\n") + "\n"
    );
  }
}

async function handleShow(name: string): Promise<void> {
  const store = await SkillStore.create();
  const skill = store.get(name);
  if (!skill) {
    output.write(`技能不存在: ${name}\n`);
    process.exitCode = 1;
    return;
  }

  const content = await store.readSkillContent(name);
  output.write(content.endsWith("\n") ? content : `${content}\n`);
}

async function handleHistory(name: string): Promise<void> {
  const store = await SkillStore.create();
  const skill = store.get(name);
  if (!skill) {
    output.write(`技能不存在: ${name}\n`);
    process.exitCode = 1;
    return;
  }

  const history = store.getHistory(name, 10);
  if (history.length === 0) {
    output.write(`"${name}" 没有执行记录。\n`);
    return;
  }

  output.write(`"${name}" 最近 ${history.length} 条执行记录:\n\n`);
  for (const record of history) {
    output.write(`${formatHistoryRecord(record)}\n\n`);
  }
}

async function handleDelete(name: string): Promise<void> {
  const store = await SkillStore.create();
  const skill = store.get(name);
  if (!skill) {
    output.write(`技能不存在: ${name}\n`);
    process.exitCode = 1;
    return;
  }
  if (skill.builtin) {
    output.write(`内置技能 "${name}" 不可删除。\n`);
    process.exitCode = 1;
    return;
  }

  const ok = await confirmDelete(name);
  if (!ok) {
    output.write("已取消删除。\n");
    return;
  }

  const deleted = await store.delete(name);
  if (!deleted) {
    output.write(`删除失败: ${name}\n`);
    process.exitCode = 1;
    return;
  }

  output.write(`已删除技能: ${name}\n`);
}

export async function runCli(args: CliArgs): Promise<void> {
  const [command, ...rest] = args;

  switch (command) {
    case "start":
      await startMcpServer();
      return;

    case "list":
      await handleList();
      return;

    case "show": {
      const name = rest[0];
      if (!name) {
        output.write("用法: pupu show <name>\n");
        process.exitCode = 1;
        return;
      }
      await handleShow(name);
      return;
    }

    case "history": {
      const name = rest[0];
      if (!name) {
        output.write("用法: pupu history <name>\n");
        process.exitCode = 1;
        return;
      }
      await handleHistory(name);
      return;
    }

    case "delete": {
      const name = rest[0];
      if (!name) {
        output.write("用法: pupu delete <name>\n");
        process.exitCode = 1;
        return;
      }
      await handleDelete(name);
      return;
    }

    case "--help":
    case "-h":
    case undefined:
      printUsage();
      return;

    default:
      output.write(`未知命令: ${command}\n\n`);
      printUsage();
      process.exitCode = 1;
  }
}
