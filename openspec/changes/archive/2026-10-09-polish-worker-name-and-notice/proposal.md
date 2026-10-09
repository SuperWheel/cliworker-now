# Proposal

## Why

v0.7.4 标题下状态条高度低于宿主新会话按钮，输入区仍显示用户要求去掉的无会话说明。名称按钮内边距与全角分隔符的字框使文字两侧间距不对称，扩大按钮时又不能挪动名称文字。

## What Changes

- 状态条与 Harness rc.2 展开侧栏的新会话按钮对齐高度，仍置于标题下。
- 删除无原生会话时输入区的说明小字，保持发送禁用和既有错误/历史。
- 扩大名称按钮，保持名称文字起点；名称和模型到分隔线的文字距离相等，按钮到线仍有间隙。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `worker-management`：状态条尺寸、无会话输入区说明和名称按钮文字间距。

## Impact

只修改 Client 的 panel、WorkerCard 和局部样式；现有源码 `panel.tsx` 的无会话提示分支、`management-styles.ts` 的状态条、`rename-copy-styles.ts` 的 4px 内边距为核查入口。Host、账号隔离、会话、模型及公开协议不变。隔离界面验收后按既有授权更新 Desktop、本地提交并归档；默认不调用真实模型。
