# Hermes Agent 接入与验证

## 原生基线

- 官方 NousResearch/hermes-agent 提交 `4787e4d56fc8d9265d4c7d3c0fe5accee86b4078`，版本 `v0.21.5+7527.g4787e4d`。
- 本机 `~/.local/bin/hermes`，代码 `~/.hermes/hermes-agent`，Python 3.14.7。依用户授权安装，跳过 `agent-browser`、`cua-driver`，不安装 Desktop，不启动 gateway。
- 原生数据 `~/.hermes`；插件不迁移旧 Harness CLI 模型/凭据。`hermesHome` 为高级覆盖项；首次使用新数据目录时，官方 launcher 会准备对应运行环境。

## 实际接口

- 登录设置：`hermes model`；账号终端：`hermes auth`。只打开原生界面，用户选择服务商并授权。没有提供未核验的全局 logout 命令。
- 目录：按顺序执行 `hermes config get model.default --json`、`model.provider --json`。只返回当前明确选择的服务商和模型；`auto` 未选型则提示登录设置。
- 任务：`hermes --in <project> chat --format stream-json --model <model> --provider <provider> --toolsets terminal,file --ignore-rules -q <prompt>`；原生公开支持的强度才传 `--reasoning`；续聊传 `--resume <session_id>`。
- 流：`system/init`、`text`、`tool_use`、`tool_result`、`result`。结果 `tokens` 投影为真实本轮用量；未公开内部推理或上下文容量不伪造。
- 默认文件写入沙箱：仅私有运行状态、已核验的原生安装锁/租约、日志/会话/数据库可写；plan 不可写项目，accept-edits 额外允许项目。原生 config、auth、.env、源码与依赖环境不可写，凭据刷新或首次 runtime 初始化通过账号终端完成。保留原生单次执行的危险命令审批。不开启 yolo，不加载额外插件或 MCP 工具，不注入宿主 API 密钥。

## 本轮证据（2026-10-06）

- 真实版本/帮助/聊天参数检查通过。`hermes model` 显示原生服务商选择器后取消，退出 0，没有填写账号、选模型或发任务。
- `.test-data/hermes-catalog-real/run-XnfdJ7/report.json`（0600）：默认 home 正确提示未选服务商；私有模拟配置通过真实 CLI 和 sandbox 返回 `fixture/model (openrouter)`。配置值为模拟，命令及沙箱为真实，模型调用次数为 0。
- 初次模型目录并行查询会竞争原生安装锁；已改顺序查询。
- 旧 Harness workers、事件与偏好保持原值；设置与工具中移除旧入口，防止将旧 session_id 交给 Hermes。
- 自动测试及隔离界面验收见 `doc/tasks.md`。真实模型完成、续聊与取消未验收，不把协议夹具或登录界面当成真实模型通过。

官方依据：[CLI 参考](https://hermes-agent.nousresearch.com/docs/reference/cli-commands)、[固定版本 stream-json](https://github.com/NousResearch/hermes-agent/blob/4787e4d56fc8d9265d4c7d3c0fe5accee86b4078/hermes_cli/stream_json.py)、[安装文档](https://hermes-agent.nousresearch.com/docs/getting-started/installation)。
