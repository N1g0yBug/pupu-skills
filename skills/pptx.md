---
name: pptx
description: 使用 Node 与 PptxGenJS 自动化生成和修改 PowerPoint 演示文稿。
triggers:
  - pptx
  - powerpoint
  - 生成幻灯片
  - 汇报 deck
  - slide automation
  - 演示文稿
calls: []
---

# pptx

## 触发条件
当任务需要“自动生成汇报 PPT、批量出图表页、套模板写内容、导出 .pptx”时使用。

## 执行步骤
1. 确认输入数据与页结构：封面、目录、正文、结论页。
2. 安装依赖：`npm i pptxgenjs`。
3. 初始化文档并设置统一主题（字体、配色、页面比例）。
4. 按页模板生成：
   - 标题页：主标题 + 副标题 + 日期；
   - 内容页：标题 + 要点列表 + 图表/图片；
   - 结论页：关键决策与下一步。
5. 图表策略：先整理数据数组，再映射到柱状/折线图。
6. 使用坐标系统（x/y/w/h）保持版式一致，避免“手调漂移”。
7. 批量生成时把每页配置抽成 JSON，便于重跑。
8. 导出后做人工检查：换行、遮挡、中文字体兼容。

## 代码参考
```javascript
// npm i pptxgenjs
const PptxGenJS = require("pptxgenjs");

async function buildPpt() {
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";

  const slide1 = pptx.addSlide();
  slide1.addText("季度业务复盘", { x: 0.6, y: 0.8, w: 12, h: 0.8, fontSize: 32, bold: true });
  slide1.addText("Q2 2026", { x: 0.6, y: 1.8, w: 6, h: 0.5, fontSize: 18, color: "666666" });

  const slide2 = pptx.addSlide();
  slide2.addText("核心指标", { x: 0.6, y: 0.3, w: 4, h: 0.5, fontSize: 24, bold: true });
  slide2.addText(["• 收入环比 +18%", "• 留存 +4.2pp", "• 成本下降 7%"], { x: 0.8, y: 1.0, w: 5.5, h: 2.5, fontSize: 18 });

  await pptx.writeFile({ fileName: "report.pptx" });
}

buildPpt();
```

## 注意事项
- 图表过多会导致可读性下降，单页只放一个主结论。
- 字体在不同系统可能替换，尽量用常见字体。
- 图片建议预压缩后再插入，控制文件体积。
- 页脚页码可统一脚本化生成，避免手工漏页。

## 改进记录
- v1: 初始版本
