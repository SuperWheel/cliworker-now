# CLI 卡片图标 v2 · 扩展六款

2026-10-05，延续 [v1](../v1/README.md) 的扁平、透明背景规格，以内置 `image_gen` 制作。六张 PNG 已保存，供父级页面 CLI 名称左侧使用；本次是素材交付，尚未接入运行界面。

| CLI | 文件 | 处理 |
| --- | --- | --- |
| ZCode | [zcode.png](zcode.png) | 保留分段斜切 Z，移除黑色应用底板，深灰填色 |
| OMP | [omp.png](omp.png) | 保留 π 形结构，移除底板，紫色平面化；为小尺寸识别将两腿调整为齐平 |
| Pi | [pi.png](pi.png) | 保留官方珊瑚、蓝、黄色块和像素结构，负空间透明 |
| Harness | [harness.png](harness.png) | 保留 DeepSeek 鲸鱼轮廓，去掉白色底板和阴影 |
| OpenCode | [opencode.png](opencode.png) | 保留方形框架、透明开口和灰色内块 |
| Grok | [grok.png](grok.png) | 采用当前 Grok Build 仓库 README 使用的 SpaceXAI 标识，保留斜向弧线与分段结构 |

Grok 的参考是 CLI 仓库所展示的品牌标识，不是旧版 Grok 圆环标识。以上均为本插件的栅格适配稿，不是官方发布的新版标识。品牌权利归各自权利方所有。

## 预览与主题

- [亮暗对照页面](preview.html)／[预览截图](preview.png)，包含放大展示及实际 24px、32px 图标槽。
- OMP、Pi 在亮暗主题共用彩色 PNG。
- ZCode、Harness、OpenCode、Grok 使用同一张 PNG；暗色主题通过 CSS `filter: invert(1)` 显示浅色版本，保持透明度与几何轮廓一致。未另外生成暗色 PNG。
- 接入时由 Harness 原生主题状态决定是否应用反色；无需新增主题开关。预览页面同时展示两种状态，只是对照展示。
- 建议统一 24px／32px 图标槽，名称间距 8px。`manifest.json` 记录主体边界、光学缩放和主题规则；预览页面演示了居中与等比缩放。
- PNG 内没有背景卡片。预览中的圆角卡片不属于图像素材。

## 已核验来源

| CLI | 参考来源 |
| --- | --- |
| ZCode | 本机官方应用 `/Applications/ZCode.app/Contents/Resources/icon.png` |
| OMP | [官方仓库 favicon](https://github.com/can1357/oh-my-pi/blob/main/packages/collab-web/public/favicon-512x512.png) |
| Pi | [官方站点标识](https://pi.dev/logo-auto.svg)，以浏览器正常渲染的截图作为参考 |
| Harness | 本机应用 `/Applications/DeepSeek Harness.app/Contents/Resources/icon.png`；[官方仓库](https://github.com/deepseek-ai/deepseek-harness) |
| OpenCode | [官方品牌方形标识](https://github.com/anomalyco/opencode/blob/dev/packages/console/app/src/asset/brand/opencode-logo-light-square.png) |
| Grok | [官方 Grok Build 仓库](https://github.com/xai-org/grok-build) README 图片；[原始 PNG](https://media.x.ai/v1/website/spacexai-symbol-black-transparent-6435cf42.png) |

原始参考位于忽略的 `.cache/icon-references/extended/` 或本机应用资源；没有修改应用文件。

## 实际验证

- 六张 PNG 均为 1254 × 1254、RGBA，四角 alpha=0，并具有大量完全透明像素；结果及 SHA-256 见 [manifest.json](manifest.json)。
- 已通过浏览器查看亮暗背景下的 24px／32px 效果，无不透明底板；图标名称与对应资产一致。
- 图像为生成式栅格适配，高倍放大存在细微边缘和色值变化，不应视为精确矢量复刻。
- PNG 从生成目录原样复制，未使用脚本抠图、重绘或改色。暗色效果只在预览 CSS 中显示。
- 完整最终提示词、参考路径和生成结果路径见 [prompts.json](prompts.json)；使用内置 image_gen，未使用 API CLI。
- 本轮只新增设计素材及预览，未运行代码构建或真实 CLI 任务。
