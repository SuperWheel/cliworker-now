# Design

## Context

v0.6.17 已把 Hermes 指引送入同次请求。真实工具参数仍漏 cli，旧 Antigravity 单 CLI 时代的兼容默认触发误派。Host 后续 chooseDispatch 正确按错误目标读取，因此应修正入口契约而非改历史偏好或做文本拦截。

## Goals / Non-Goals

- Goals: 所有新 cliworker_start 调用必须显式指定 CLI；遗漏参数无选型、账号查询或发布副作用。
- Non-Goals: 不改原生 CLI 协议、用户日志、旧 Worker 或偏好，不从 prompt/title/上次调用猜 CLI，不增加问题卡或通用提问 guard。

## Decisions

1. cli 参数 required=true，使用原生 defineTool 参数验证；execute 删除 `?? antigravity`，只解析实际 cli。不另建拦截器。
2. 保留规范 ID、别名和已有唯一轻微拼写解析。必填字符串中的未知、空白和多目标沿用已有无副作用错误。
3. 保留 cliOf 的历史兼容：省略 cli 的历史 Worker 仍代表最初的 Antigravity；只读 catalog 兼容入口和旧偏好格式不代表可省略新派遣目标。新建仅从 cliworker_start 进入，续聊通过精确 worker 身份保留原 CLI。
4. 测试原生工具 schema 及执行校验，并结合实际 WorkerStorage 验证同项目/对话双 CLI 设定隔离；原生 UI 使用模拟目录和禁止真实启动的夹具。

## Risks / Trade-offs

旧模型若模仿历史无 cli 参数，会收到原生参数错误并需补正；不能以兼容为由启动其他 CLI。模型显式填错另一个有效 CLI 不属于本次实际漏参根因，本轮不引入推断覆盖。保留历史供查阅，不改误派后已停止的记录。

## Migration Plan

无需数据迁移。类型检查、回归与预览验收后，在无活动任务时更新 Desktop 0.6.18；核对账号/历史文件和组件版本。本地提交不推送。回退需恢复版本包，存储未变；不恢复静默默认作为运行修复。
