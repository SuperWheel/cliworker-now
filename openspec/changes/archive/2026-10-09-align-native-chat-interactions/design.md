# Design

## Context

当前 panel.tsx 的返回最新按钮位于滚动区之外并带文字；conversation-timeline.tsx 始终展示功能条；续聊 textarea 没有键盘处理。原生 0.2.0-rc.2 的 ui-chat 内部返回按钮/消息功能条和 ui-conversation 内部 Lexical keymap 没有可安全复用的独立公开导出；主聊天输入组件绑定 InputHub 和主会话 remote，不能用于 Worker。

## Goals / Non-Goals

目标是 v0.7.1 对齐用户要求的三个交互，并说明复用边界。复用 primitives 的公开向下图标、原生主题 token 和已有 Button/Tooltip；按已核查的原生源码对齐私有交互逻辑。不更换 Host 协议、不提交主会话、不引入运行中插话或排队能力，也不新增输入设置。

## Decisions

- 返回按钮放在滚动内容容器的浮层，按原生尺寸、边距、主题、hover/active反馈；点击直接回底部，保留现有跟随和历史翻页边界。不自行增加原生不存在的平滑滚动或按钮入出场动效。
- 计算真实 live timeline 的最后用户消息和 AI 回复 ID，传入历史/实时渲染；新用户轮到达后隐藏前轮 AI 功能条。更早功能条在支持悬停的设备上使用原生 opacity 80ms 和 hover/focus-within 规则（用户整条消息、AI回复尾部），触屏常显，不移除 DOM 或改变高度。
- textarea 使用注明来源的局部 keymap 适配器，执行原生组合输入/确认短窗口、repeat和修饰键规则，通过原有表单提交。正常 Enter/单独 Ctrl或Cmd+Enter同一续聊入口，Shift+Enter换行。原生 busyEnter仅控制运行中queue/steer，而 Worker 运行中不可续聊，因此不新增设置桥或误用主会话 InputHub。
- 保持生命周期清理和草稿成功清除逻辑；新增状态只在 Client内存，不持久化账号或用户内容。单元回归验证事件规则、正确 Worker 和草稿失败保留；隔离 Harness UI 使用模拟数据验证样式、hover/focus与实际键盘交互。

## Risks / Trade-offs

私有实现复制需要明确绑定 rc.2；版本升级时重新核对并保留来源清单。透明度隐藏依旧保留焦点能力，与原生保持一致。IME按原生10ms保护窗口，测试覆盖event.isComposing、229和compositionend；验收不发送真实模型请求。更新前检查任务空闲，保留账号和历史，可通过上一提交恢复原 Client构建。
