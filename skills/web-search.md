---
name: web-search
description: 使用 Claude Code 的网页检索与抓取能力进行研究、抽取和交叉验证。
triggers:
  - 网页搜索
  - web search
  - 抓取网页
  - scrape
  - API 调用
  - fetch url
  - 资料调研
calls: []
---

# web-search

## 触发条件
当你需要“查最新资料、比对多来源、抓取页面字段、调用公开 API、生成结构化研究结果”时使用。

## 执行步骤
1. 定义问题与输出格式：先写清楚你要的字段（例如标题、发布日期、版本号、链接）。
2. 先搜索后抓取：先拿到候选来源，再对高质量来源做深抓取。
3. 来源分层：官方文档 > 标准组织 > 维护者博客 > 社区讨论。
4. 抽取时使用固定 schema（JSON 字段）保证可复用。
5. 每条关键信息至少做一次交叉验证（两源一致再采信）。
6. 对 API 调用记录：请求 URL、参数、状态码、重试次数。
7. 遇到失败按顺序处理：
   - 超时：缩小页面、降低并发、重试；
   - 429：指数退避并减少频率；
   - 403：换官方镜像或文档入口。
8. 输出时标注时间敏感性：哪些是“截至当前时间”的结论。

## 代码参考
```javascript
// 结构化抽取模板（示意）
const result = {
  topic: "Node.js PDF library comparison",
  collectedAt: new Date().toISOString(),
  items: [
    { source: "official", title: "pdf-lib docs", url: "...", keyPoints: ["browser/node", "merge pages"] }
  ]
};

// 简单重试 + 退避（伪代码）
async function withRetry(fetcher, max = 3) {
  for (let i = 0; i < max; i++) {
    try { return await fetcher(); }
    catch (e) {
      if (i === max - 1) throw e;
      await new Promise(r => setTimeout(r, 500 * 2 ** i));
    }
  }
}
```

## 注意事项
- 不要只给结论，必须保留可追溯来源链接。
- 避免单一来源“拍脑袋”总结。
- 对营销页与聚合站信息保持怀疑，优先官方 changelog。
- 涉及价格/政策时标注“可能随时间变化”。
- 大规模抓取要控制节奏，避免触发限流。

## 改进记录
- v1: 初始版本
