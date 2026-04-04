---
name: grep
description: 通过高质量检索策略快速定位代码与文本问题，支持多文件与正则场景。
triggers:
  - grep
  - 全局搜索
  - regex search
  - 查引用
  - 批量定位
  - 文本检索
calls: []
---

# grep

## 触发条件
当你需要“快速定位 bug 线索、统计模式分布、追踪旧 API 残留、跨目录检索文本/代码”时使用。

## 执行步骤
1. 先定义搜索目标类型：字面量、正则模式、结构性语法。
2. 缩小搜索面：限定目录与后缀（如 `src/**/*.ts`），避免噪音。
3. 先跑计数模式确认规模，再切换内容模式查看上下文。
4. 正则策略：
   - 先写最小可用表达式；
   - 再逐步加边界（`\\b`）和分组，降低误报。
5. 多文件排除：跳过构建产物、锁文件、二进制目录。
6. 修复任务建议“三段检索”：
   - 段1：查现象关键词；
   - 段2：查关联函数/配置；
   - 段3：查旧实现残留。
7. 修改后必须反向验证：再次搜索旧模式确保清零。
8. 输出检索结论：命中文件、热点区域、下一步操作建议。

## 代码参考
```javascript
// 示例1：统计命中规模
await grep({
  pattern: "TODO|FIXME",
  include: "*.{ts,tsx,js}",
  path: "src",
  output_mode: "count"
});

// 示例2：查看上下文线索（先 content，再读文件细节）
await grep({
  pattern: "legacyAuth\\(",
  include: "*.ts",
  path: "src",
  output_mode: "content"
});

// 示例3：仅返回命中文件清单
await grep({
  pattern: "process\\.env\\.",
  include: "*.{ts,js}",
  path: "src",
  output_mode: "files_with_matches"
});
```

## 注意事项
- 检索是“定位工具”，不是证据终点；关键位置要回到文件全文确认。
- 正则写太宽会误报，写太窄会漏报，需迭代平衡。
- 搜索结果多时先分目录分层处理，不要一次性全改。
- 不要把 `node_modules`、`dist` 结果当源码证据。

## 改进记录
- v1: 初始版本
