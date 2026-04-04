---
name: image-analysis
description: 结合 Claude 视觉能力与 Node 图像库完成识别、转换、压缩和元数据提取。
triggers:
  - 图片分析
  - image analysis
  - OCR
  - 图片压缩
  - 格式转换
  - metadata
calls: []
---

# image-analysis

## 触发条件
当任务涉及“看图提取信息、OCR 识别、批量缩放、格式转换、读取 EXIF、生成缩略图”时使用。

## 执行步骤
1. 先判定目标：
   - 语义理解（页面里有什么）→ 用视觉分析能力；
   - 像素处理（缩放/裁剪/压缩）→ 用 `sharp`。
2. 若需本地图像处理，安装依赖：`npm i sharp`。
3. 批量处理流程：
   - 收集输入文件列表；
   - 按规则转换（尺寸、格式、质量）；
   - 输出到独立目录。
4. OCR 场景：
   - 先做预处理（灰度、增强对比度、去噪）；
   - 再提取文本，提高识别率。
5. 元数据提取：读取宽高、色彩空间、拍摄信息（若存在 EXIF）。
6. 质量控制：
   - 压缩后检查视觉可接受性；
   - 关键图保留高质量版本。
7. 结果输出建议：图像处理日志 + 失败项列表 + 产物路径。

## 代码参考
```javascript
// npm i sharp
const sharp = require("sharp");
const fs = require("fs");

async function processImage(input, output) {
  await sharp(input)
    .resize({ width: 1600, withoutEnlargement: true })
    .jpeg({ quality: 82, mozjpeg: true })
    .toFile(output);
}

async function getMeta(file) {
  const meta = await sharp(file).metadata();
  return { width: meta.width, height: meta.height, format: meta.format, space: meta.space };
}
```

## 注意事项
- OCR 前预处理通常比“直接识别”更关键。
- 透明通道图片转 JPEG 会丢透明背景，必要时保留 PNG/WebP。
- 批量处理注意命名冲突，建议输出名带后缀（如 `_compressed`）。
- 含敏感信息图片要避免上传到外部服务。

## 改进记录
- v1: 初始版本
