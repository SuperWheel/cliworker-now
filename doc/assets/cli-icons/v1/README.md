# CLI 卡片图标 v1

2026-10-04，以内置 `image_gen` 基于官方素材／本机官方应用资源制作的扁平适配稿。用于父级页面 CLI 名称左侧；本次只交付设计素材，尚未接入插件运行界面。

## 文件

| CLI | 透明 PNG | 设计处理 |
| --- | --- | --- |
| Antigravity | [antigravity.png](antigravity.png) | 保留当前官方拱形轮廓，渐变改为蓝色平面色 |
| Codex | [codex.png](codex.png) | 保留蓝色花形终端符号，去除外层白色底板与立体效果 |
| Claude Code | [claude-code.png](claude-code.png) | 使用官方橙色星芒标识，保持不规则轮廓 |
| Kimi，亮色主题 | [kimi-light.png](kimi-light.png) | 深色 K、蓝点，移除黑色应用底板 |
| Kimi，暗色主题 | [kimi-dark.png](kimi-dark.png) | 浅色 K、蓝点，与亮色版对应 |
| MiMo Code | [mimo-code.png](mimo-code.png) | 从官方字标左侧的像素 M 提炼单字图标，移除重叠描边 |

MiMo M 是本插件的字标提炼设计，并非声称官方已经提供此独立图标。整组为适配稿；品牌标识归原权利方所有。

## 预览与使用

- [亮暗预览页面](preview.html)，可直接用浏览器打开；其中背景卡片仅用于展示，不属于 PNG。
- [预览截图](preview.png)，包含 24px、32px 和放大展示。
- 每张原图为 1254 × 1254 RGBA PNG，四角 alpha=0，具有真实透明通道。
- 父级标题建议采用统一 24px 或 32px 图标槽，图标与名称间距 8px。不要新增不透明底板。
- Kimi 按 Harness 的主题状态选择 light/dark 文件；其余四种共用同一张 PNG。
- 各图内留白不同，`manifest.json` 记录 alpha≥128 的主体边界及建议光学缩放；`preview.html` 展示了居中和缩放的 CSS 用法。保持等比，不拉伸。生产接入时需复用宿主主题状态，不能另设一套主题开关。
- 这些是栅格适配稿，不是矢量 SVG；高倍放大可见抗锯齿与生成细节。

## 来源

仅将以下已核验素材用作参考；来源原图保存在忽略的 `.cache/icon-references/`，没有修改用户安装的应用资源。

| CLI | 核验来源 |
| --- | --- |
| Antigravity | [官方 Press Assets](https://antigravity.google/press)，[全彩图标 PNG](https://antigravity.google/assets/image/brand/antigravity-icon__full-color.png) |
| Codex | 本机官方应用 `/Applications/ChatGPT.app/Contents/Resources/icon-codex-light.png`；[官方 Codex 仓库](https://github.com/openai/codex) |
| Claude Code | [官方产品页](https://claude.com/product/claude-code)，[官方星芒图标](https://assets.claude.com/95a868946ac8a31e5ff832e2899f294aa368b836.png?w=32&h=32) |
| Kimi | [官方 Kimi Code 仓库图标](https://github.com/MoonshotAI/kimi-code/blob/main/apps/vscode/webview-ui/public/kimi-logo.png) |
| MiMo Code | [官方仓库字标](https://github.com/XiaomiMiMo/MiMo-Code/blob/main/assets/readme/mimocode-banner.png) |

## 验证与提示词

`manifest.json` 记录每张图的透明像素、尺寸、四角透明情况和主体边界。通过本地浏览器检查了 24px／32px 的亮暗显示，未出现不透明底板。预览截图与原 PNG 是不同用途的文件。

完整生成提示词及参考素材路径见 [prompts.json](prompts.json)。使用内置 image_gen；未使用 API CLI，也没有通过脚本重绘、抠图或改色。PNG 从生成目录原样复制进项目，预览只通过 CSS 控制显示尺寸。
