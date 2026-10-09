# Proposal

## Why

筛选进行中、已完成或异常时，截图显示的匹配说明和清除筛选文字是额外信息。用户要求删除所有状态下的这两处文字。

## What Changes

- 移除总览筛选信息栏，包括匹配数量/空结果说明及清除筛选操作。
- 搜索和四筛选保留；清空搜索并选全部仍可恢复列表，初始空页和回收空页保持。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `worker-management`：固定筛选区简化，不显示筛选说明和清除文字。

## Impact

Client panel.tsx生成cwn-filter-info的分支及其CSS、对应面板回归、双语README。Host、账号、模型、会话数据不改。隔离preview验收后更新Desktop，本地提交归档，不推送、不发起真实生成。
