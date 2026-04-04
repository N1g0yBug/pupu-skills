---
name: filesystem
description: 使用 Claude Code 原生文件工具完成读写、搜索、遍历与批量处理。
triggers:
  - 文件系统
  - file system
  - 读文件
  - 写文件
  - 批量改文件
  - recursive search
  - 目录遍历
calls: []
---

# filesystem

## 触发条件
当任务包含“读取/修改多个文件”“按模式查找文件”“跨目录重构”“批量生成文件”“清理目录结构”时使用本技能。

## 执行步骤
1. 明确范围：先锁定根目录与文件类型（例如 `src/**/*.ts`、`docs/**/*.md`）。
2. 用文件匹配工具做“文件级发现”，不要盲扫全盘。
3. 用内容搜索工具做“内容级定位”，先统计命中数量，再逐步收敛。
4. 先读后改：每次修改前读取上下文（函数、段落、配置块），避免误改。
5. 批量修改分两类：
   - 结构化改动：优先 AST/LSP 级工具；
   - 文本改动：用可回放的替换规则，分批执行。
6. 新建文件前检查父目录是否存在；若不存在先创建目录。
7. 大规模改动采用“试运行 -> 小批量验证 -> 全量执行”三段式。
8. 修改后进行一致性检查：重复搜索旧模式，确认无残留。
9. 最后输出变更清单：修改了哪些文件、为什么改、是否有未覆盖风险。

## 代码参考
```javascript
// 1) 文件发现（示意）
const files = await glob("src/**/*.ts");

// 2) 内容定位（示意）
const hits = await grep({
  pattern: "legacyFunction\\(",
  include: "*.ts",
  path: "src",
  output_mode: "content"
});

// 3) 读取并修改（伪代码）
for (const file of files) {
  const text = await read(file);
  const next = text.replaceAll("legacyFunction(", "newFunction(");
  if (next !== text) await write(file, next);
}

// 4) 回归验证：再次搜索旧关键词
const remain = await grep({ pattern: "legacyFunction\\(", include: "*.ts", path: "src" });
```

## 注意事项
- 优先“小步快跑”，避免一次性跨数百文件不可回滚。
- 路径含空格时命令参数必须加引号。
- 不要在未知目录直接删除文件，先列目录再执行。
- 批量替换前先做样本文件验证，尤其是正则替换。
- 文件监听（watch）适用于持续任务：
  - 监听 `src/**` 变化后自动跑检查脚本；
  - 避免监听过宽导致高 CPU。

## 改进记录
- v1: 初始版本
