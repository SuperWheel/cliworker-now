# Hermes Agent 图标

2026-10-06，按用户“harmes”的 CLI 上下文，以 Nous Research 的 **Hermes Agent** 为对象，延续前两批图标的透明、扁平规格制作。仅新增设计素材，尚未接入插件，也不代表已经支持 Hermes CLI 派遣。

## 交付与主题

- [hermes.png](hermes.png)：1254 × 1254 RGBA 透明 PNG，深灰色头像，保留发型、发箍和面部轮廓，简化细碎线条。
- [preview.html](preview.html)／[preview.png](preview.png)：亮暗主题、24px／32px 图标槽和标题位置示例。
- 暗色主题通过 CSS `filter: invert(1)` 呈现浅色图形；同一张 PNG，无独立暗色文件。实际接入应由 Harness 原生主题状态控制。
- 建议图标槽 24px 或 32px，与名称间距 8px；光学缩放及主体边界见 [manifest.json](manifest.json)。图内负空间与外部背景均透明，预览卡片不属于 PNG。

## 官方参考

- [Hermes Agent 官方网站](https://hermes-agent.nousresearch.com/)
- [官方仓库](https://github.com/NousResearch/hermes-agent)
- [应用图标参考](https://github.com/NousResearch/hermes-agent/blob/main/website/static/img/apple-touch-icon.png)，Git blob `3fa3feb14fec8b6a2fc272f22c4587b2c2c4d408`。
- [头像轮廓参考](https://github.com/NousResearch/hermes-agent/blob/main/website/static/img/logo-dark.png)，Git blob `9e1a47c124f3ee9aede0c6e90eebba800dfe77ae`。

这是一份基于官方头像的本插件适配稿，不是官方发布的新品牌图标；品牌权利归原权利方。参考文件保存在忽略的 `.cache/icon-references/hermes/`。

## 实际验证

- 已检查 RGBA 通道，四角 alpha 均为 0，完全透明像素 935,553 个，SHA-256 见 manifest。
- 已在浏览器查看亮暗背景和 24px／32px 显示，无不透明底板，头像轮廓可辨。24px 主要依靠发型轮廓识别，细小面部线条会自然弱化。
- 使用内置 image_gen；完整提示词及参考路径见 [prompts.json](prompts.json)。PNG 原样复制进项目，未使用脚本抠图或重绘。
- 栅格生成图高倍放大可能有细微边缘或色值变化，不是精确矢量复刻。
- 仅素材变更，未运行插件构建或真实 CLI 任务。
