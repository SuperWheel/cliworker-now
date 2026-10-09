# Design

## Context

原生 jobs 菜单是标题行内联 ul。标题 container-type 创建 stacking context，中央列 overflow:hidden 与右侧栏独立层级共同裁剪遮挡；不是插件按钮本身的 z-index。旧 9cffdf Worker 创建于账号绑定机制前，raw/init 与原生 conversation 摘要没有账号身份，不能可靠绑定当前账号。现有卡片是整张 button，名称仅 span；renameWorker 只改名称，title/delete 未提供。

## Goals / Non-Goals

实现六项改进并交付 v0.7.2。保留自身账号隔离、不修改 Harness 核心、不猜测原账号或执行真实模型、不重写历史文本、不清除原生会话或凭据。

## Decisions

- 插件生命周期内观察实际原生 header/jobs DOM；只在 CLI Worker 可见且 jobs 菜单展开时标记裁剪与 stacking context 祖先，限定 CSS 放开溢出及提升标题层级；关闭、选中其他标签或卸载时恢复，沿用原生组件及订阅。
- runtime snapshot 提供安全的缺绑定阻塞状态，Client 阻止旧续聊并提供显式新建模式。新建 remote 验证归属、空闲、CLI/权限/当前自身账号和原选型，走相同 launch/new Worker 路径，保留角色；失败不清稿，不迁移旧 session ID。
- shared effortLabel 只格式化显示；Host 问题 label 按实际支持值映射，不修改协议。默认按 CLI short stem 命名，storage 对可识别旧默认名生成短名、保留旧别名，自定义与名称冲突受现有父会话约束。
- 通过私有墓碑/归档标记实现可恢复删除，原 Worker、账号绑定及事件仍保留；runtime get/resolve/submit 对删除任务拒绝，恢复保留原 ID，名字保持占用。Client 提供已删除入口；标题与名称用独立编辑操作，原子保存失败不改内存。
- 进程清理未确认在源头写入 Host 私有持久阻塞记录，重启继续阻止管理和执行；记录无可信退出证据不自动清除，损坏记录按阻塞处理。不通过旧错误文案推测清理状态。
- 卡片改为容器、独立打开按钮及名称复制按钮，避免嵌套按钮；复用公开 Menu 的 portal/指针定位与 Tooltip（rc.2 无独立 ContextMenu 导出），复制反馈复用现有 clipboard 工具。所有 listeners/observer/timer/abort 均清理。

## Risks / Trade-offs

宿主 DOM 兼容适配固定 rc.2 并以原生 UI 验收；升级须重新核对。无旧账号证据的记录只能明确新开，不能声称恢复原对话身份。短名迁移只针对缺名或旧 CLI 默认「助手-序号」格式及标记 auto 的名称；旧格式没有来源标记，以格式识别并保留精确别名，不按角色名称模式迁移，标记 custom 的名称保留。旧别名不可歧义。软删除保留存储，可恢复，活动任务/清理阻塞继续拒绝。预览使用模拟账号/任务/菜单，不生成真实内容；正式更新前检查空闲并核对数据改动范围。
