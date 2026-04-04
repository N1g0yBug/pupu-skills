---
name: pdf
description: 使用 Node 工具链完成 PDF 读取、抽取、合并与页面级处理。
triggers:
  - pdf
  - 提取 pdf 文本
  - 合并 pdf
  - split pdf
  - pdf 处理
  - pdf-lib
calls: []
---

# pdf

## 触发条件
当任务涉及“读取 PDF 文本、按页拆分、多文件合并、插入水印、重排页面、导出新 PDF”时使用。

## 执行步骤
1. 判断任务类型：
   - 文本抽取：`pdf-parse`；
   - 页面编辑与合并：`pdf-lib`。
2. 检查依赖，缺失则安装：`npm i pdf-lib pdf-parse`。
3. 文本抽取流程：读取文件 Buffer -> `pdf-parse` -> 输出 text + 页数。
4. 合并流程：新建 PDF -> 逐个加载源 PDF -> 复制页面 -> 保存。
5. 拆分流程：遍历每页生成独立文档，命名带页码。
6. 页面重排：定义页码序列数组（如 `[2,1,3]`），按序复制。
7. 加水印：在每页绘制半透明文字，避免遮挡正文。
8. 批处理：输入目录 + 输出目录分离，并记录失败文件列表。
9. 完成后验证：能打开、页数正确、文本可搜索（若源文档支持）。

## 代码参考
```javascript
// npm i pdf-lib pdf-parse
const fs = require("fs");
const { PDFDocument } = require("pdf-lib");
const pdfParse = require("pdf-parse");

async function mergePdf(files, out) {
  const merged = await PDFDocument.create();
  for (const file of files) {
    const src = await PDFDocument.load(fs.readFileSync(file));
    const pages = await merged.copyPages(src, src.getPageIndices());
    pages.forEach(p => merged.addPage(p));
  }
  fs.writeFileSync(out, await merged.save());
}

async function extractText(file) {
  const data = await pdfParse(fs.readFileSync(file));
  return { pages: data.numpages, text: data.text };
}
```

## 注意事项
- 扫描件 PDF 通常无可选文本，需 OCR（可结合图像技能）。
- 大文件处理注意内存，优先分批。
- 页码是 0 基还是 1 基要统一，避免错页。
- 某些加密 PDF 需要先解密或获取权限。

## 改进记录
- v1: 初始版本
