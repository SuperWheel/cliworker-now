# CLI Worker Now · 黑白配色

以用户已确认的 official-v1/cliworker-now.png 为输入，通过内置 image_gen 生成黑色透明版本。展示页在白底显示黑标，在黑底将同一图像反白显示。蓝色正式原图未变。

- [黑色透明 PNG](cliworker-now-black.png)
- [黑白效果图](preview.png)
- [展示页](preview.html)

已查看浏览器中大图与 24/32/48px 图标槽。PNG 保留透明通道；生成式改色的 alpha 与正式原图并非逐像素相同，因此本版为黑白配色候选，不替换正式源图。反白效果由展示页 CSS 实现，并未另外生成白色 PNG。按用户要求不保存提示词。
