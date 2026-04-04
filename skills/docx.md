---
name: docx
description: 用 Node 与轻量库生成、修改和解析 Word（.docx）文档。
triggers:
  - docx
  - word 文档
  - 生成报告
  - 模板填充
  - 表格到 word
  - create word
calls: []
---

# docx

## 触发条件
当任务要求“生成 Word 报告、套用模板、批量填充占位符、插入表格/图片、导出 .docx”时使用。

## 执行步骤
1. 先确认目标：新建文档还是基于模板改写（模板优先，稳定性更高）。
2. 检查 Node 环境，若缺依赖使用 npm 安装 `docx`、`pizzip`、`docxtemplater`。
3. 新建文档场景：
   - 用 `docx` 组装段落、标题、表格；
   - 设置统一样式（字体、字号、段前后距）。
4. 模板填充场景：
   - 在模板中放置占位符（如 `{{name}}`）；
   - 用 `docxtemplater` 填充数据并输出新文件。
5. 图片处理：先把图片缩放到目标宽高再插入，避免文档体积暴涨。
6. 表格建议：先在 JSON 中定义列结构，再映射为 Word 表格，便于复用。
7. 输出后做自检：
   - 文件可打开；
   - 关键字段无空值；
   - 页眉页脚是否按预期。
8. 批量生成时，为每个文档记录输入数据与输出路径。

## 代码参考
```javascript
// npm i docx
const fs = require("fs");
const { Document, Packer, Paragraph, HeadingLevel, Table, TableRow, TableCell } = require("docx");

async function buildDocx() {
  const doc = new Document({
    sections: [{
      children: [
        new Paragraph({ text: "项目周报", heading: HeadingLevel.HEADING_1 }),
        new Paragraph("本周完成：接口优化、测试补齐、发布准备。"),
        new Table({
          rows: [
            new TableRow({ children: [new TableCell({ children: [new Paragraph("模块")] }), new TableCell({ children: [new Paragraph("状态")] })] }),
            new TableRow({ children: [new TableCell({ children: [new Paragraph("支付")] }), new TableCell({ children: [new Paragraph("完成")] })] })
          ]
        })
      ]
    }]
  });

  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync("report.docx", buffer);
}

buildDocx();
```

## 注意事项
- 不使用 Python；仅使用 Node 脚本与 npm 包。
- `.docx` 本质是 zip + XML，复杂场景可解压后定点修改 XML，但要谨慎。
- 模板占位符命名统一，避免 `{{Name}}` 与 `{{name}}` 混用。
- 生成前先清理旧输出，避免误读历史文件。

## 改进记录
- v1: 初始版本
