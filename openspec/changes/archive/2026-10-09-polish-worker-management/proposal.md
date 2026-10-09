# Proposal

## Why

v0.7.1 仍存在原生后台任务菜单被侧栏遮挡、旧任务缺少账号绑定却允许输入续聊、显示小写强度和长默认名称、卡片不能右键管理及名称无法复制的问题。证据在 Client panel.tsx 的整卡 button/仅 conversationId 判断、Host index.ts 的缺绑定拒绝、runtime.ts 的助手默认名与 shared/types.ts 的原样强度 label；原生中央列 overflow 与标题 stacking context 限制后台菜单。

## What Changes

- v0.7.2 在 CLI Worker 显示且原生后台任务菜单展开时解决中央列裁剪及层级，关闭或卸载后恢复原生布局。
- 缺少账号绑定的历史会话在界面明确阻止续聊，允许用户按原模型/强度/角色以当前自身账号新建对话并发送。不能自动补旧账号绑定或在旧 CLI 会话换号。
- 全部展示入口使用首字母大写强度，协议值不变；默认名称使用 agy/codex/claude/kimi/mimo/zcode/grok/omp/pi/hermes/opencode 的短序号。迁移可确认自动名并保留旧名兼容，用户自定义名不变。
- 卡片右键原生菜单支持打开、修改聊天标题、修改名称、删除；删除可恢复且不删除原生会话/账号，运行或清理未确认时拒绝；明确清理阻塞持久保存，重启继续拒绝管理和执行。
- 名称独立可点击复制，悬停反馈、结果和键盘操作完整，不触发打开卡片。

## Capabilities

### New Capabilities
- `worker-management`: 子智能体名称、标题、可恢复删除、历史阻塞重开与原生后台菜单兼容。

### Modified Capabilities
无既有账号隔离或续聊规则放宽。

## Impact

Host runtime/storage/index 与公开 Gateway 新管理入口；WorkerSnapshot 增加安全的续聊阻塞信息，Worker 保留兼容字段。Client 卡片/编辑菜单/名称复制/层级适配，shared 显示函数及测试。无新增依赖，不修改 Harness 核心，不调用真实模型。README、设计、验证记录及 Desktop 同步；原账号/历史/用户图标改动保留。
