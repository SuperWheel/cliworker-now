# CLI Worker Now 图标第二轮候选

用户否定 v1：蓝色终端块与 `>_` 过于接近 Codex。因此本轮彻底移除终端符号、终端窗口和花形轮廓，提供三种独立方向。均为扁平、透明背景 PNG，由内置 image_gen 生成。

| 候选 | 图像 | 含义 |
| --- | --- | --- |
| A · 会话气泡 | [a-dialogue.png](a-dialogue.png) | 两个交错的气泡，表达主 Agent 与子 Agent 的会话关系 |
| B · 任务分派 | [b-dispatch.png](b-dispatch.png) | 一个父节点连接三个子节点，表达派遣和层级 |
| C · Worker W | [c-worker-w.png](c-worker-w.png) | 以 Worker 的 W 作为独立字母标识 |

三张均为候选，尚未由用户选定，不是正式启用的项目标识。v1 仅保留供追溯。

- [完整生成提示词](prompts.json)
- [尺寸与透明通道检查](verification.json)
- 生成后原样复制进项目，没有通过脚本改色、抠图或重绘。PNG 为栅格，边缘含抗锯齿；本轮检查生成图和 alpha，未做运行界面接入或小尺寸 UI 验收。
