# Proposal

## Why

当前项目的设计和实际验证集中在按版本追加的 `doc/design.md`、`doc/tasks.md` 中，旧范围与后续完成记录并存。需要一个能将本次需求、规格差异、实施任务和完成证据关联起来的开发流程，避免把历史待办或宣传文案当成现状。

## What Changes

- 将 OpenSpec 1.14.1 固定为项目开发依赖，提供本地执行、变更列表及严格校验命令。
- 使用官方 `spec-driven` schema 和 Codex core 技能；通过中文项目配置保留现有架构、权限、会话和验收约束。
- 建立开发流程规格及本次接入 change，完整演练准备、实施、校验和归档。
- 在 `AGENTS.md`、README、设计和任务记录中连接新的开发入口；新增 `doc/openspec.md` 操作指南与业务能力域索引。
- 业务规格随真实变更逐步增加。范围外：全量转换旧文档、补做历史 CLI 验收、修改插件功能、更新 Desktop、改写已有用户技能、启用云端服务或自动发起模型调用。

## Capabilities

### New Capabilities

- `development-workflow`：可复现的项目开发工具入口，变更与已落实规格的分工，基于证据的验证与归档。

### Modified Capabilities

无。接入前本仓库没有 OpenSpec 规格；已有运行时行为保持原状。

## Impact

影响 `package.json`、`pnpm-lock.yaml`、新增 `.agents/skills/openspec-*`、`openspec/` 和开发文档。依据当前 `package.json` 的 0.6.6 版本及源码核查，Host/Client/共享协议、现有安装协议和 CLI 会话存储均无需变更。OpenSpec 仅用于开发，不加入插件运行时依赖，不提升插件版本。
