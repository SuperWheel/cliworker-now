# Proposal

## Why

CLI Worker 子对话的返回最新按钮、历史消息功能条和回车发送与 Harness 主聊天不一致，造成浏览和续聊操作割裂。v0.7.1 对齐 Harness 0.2.0-rc.2 的原生交互，并优先使用实际公开组件、主题参数和用户设置。

## What Changes

- 返回最新消息改为原生圆形向下图标按钮，位置、颜色、反馈与回底部行为按原生实现。
- 仅最新用户消息和最新 AI 回复功能条保持显示；历史功能条悬停或键盘聚焦时显示，透明度动效与原生一致。
- 输入框遵循 Harness 原生发送模式，支持 Enter/修饰键、换行、中文输入法组合保护及防重复发送。
- 版本更新至 v0.7.1，记录原生可复用入口和未公开实现的兼容依据。

## Capabilities

### New Capabilities

- `worker-conversation-interaction`：子对话的滚动、消息功能条显示及输入提交交互。

### Modified Capabilities

无。

## Impact

Client 的 panel、conversation-timeline、styles 及原生设置接入，相关界面/行为回归测试、包版本和中英文说明。已有源码中返回最新为带文字按钮、功能条常显、textarea 缺少键盘发送逻辑。不调整 Host 派遣、认证、模型协议和用户历史；真实模型生成不属于默认验收。原生内部组件不能安全单独调用时，使用公开图标/主题/设置并按已核对的原生逻辑实现兼容层，不改 Harness 核心。
