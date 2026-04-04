---
name: xlsx
description: 使用 Node 与 xlsx/exceljs 完成 Excel 的读取、写入、公式和样式处理。
triggers:
  - xlsx
  - excel
  - 表格处理
  - 导出报表
  - 读写工作簿
  - spreadsheet
calls: []
---

# xlsx

## 触发条件
当任务需要“读取 Excel 数据、生成报表、写入公式、多 sheet 汇总、导出 .xlsx”时使用。

## 执行步骤
1. 明确需求：只读数据（`xlsx` 快）还是需要样式/复杂格式（`exceljs` 更强）。
2. 安装依赖：`npm i xlsx`，若需要高级样式再加 `exceljs`。
3. 读数据：
   - 加载 workbook；
   - 选择 sheet；
   - 转 JSON（首行为表头）。
4. 写数据：
   - 先定义列顺序；
   - 批量 append 行；
   - 输出到新文件，避免覆盖原始输入。
5. 公式处理：在单元格写入 `=SUM(A2:A10)` 等，避免提前计算死值。
6. 汇总场景：对每个 sheet 计算指标，再写到 `Summary` 页。
7. 格式化（如使用 exceljs）：设置数字格式、冻结首行、自动筛选。
8. 校验：行数、关键列空值、公式是否存在。

## 代码参考
```javascript
// npm i xlsx
const XLSX = require("xlsx");

// 读取
const wb = XLSX.readFile("input.xlsx");
const ws = wb.Sheets[wb.SheetNames[0]];
const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });

// 写入
const outWb = XLSX.utils.book_new();
const outWs = XLSX.utils.json_to_sheet(rows);
XLSX.utils.book_append_sheet(outWb, outWs, "Data");
XLSX.writeFile(outWb, "output.xlsx");
```

## 注意事项
- 列名统一：避免“金额”/“金额(元)”混用导致字段错位。
- 日期列要明确时区与格式。
- 超大表先流式或分段处理，避免一次读入内存。
- 不要把业务逻辑写死在列号，优先按表头映射。

## 改进记录
- v1: 初始版本
