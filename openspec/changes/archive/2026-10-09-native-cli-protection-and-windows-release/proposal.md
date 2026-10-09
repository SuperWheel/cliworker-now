# Proposal

## Why

用户要求更新 GitHub、发布新版、默认中文并提供完整英文首页，以及只含一行的跨平台安装命令；核查当前公开最新版为 v0.6.5，本地完成至 v0.6.14。当前六个新增 CLI 在 extended-adapters/hermes-sandbox 硬依赖 macOS Seatbelt，Windows 启动入口、路径和认证链接也存在真实缺口。用户已明确决定取消插件附加操作系统沙箱，使用 CLI 原生保护，账号隔离以 Host 正确识别本 CLI 自身来源为准。

## What Changes

- 取消任务、目录查询和账号终端的插件附加 OS 沙箱，保留原生模式、宿主授权、模型范围、账号版本和进程清理。
- Windows 解析实际官方原生入口，以 argv 执行；修正盘符/UNC、认证路径、MiMo 登录、Hermes launcher 和进程归属，不依赖 macOS 特有目录。
- 建立 Windows 原生 CI 验证，使用临时模拟账号验证启动、账号识别、取消及后代清理，不生成模型内容。
- 发布 v0.6.15 的预构建包与 SHA256；更新默认中文 README 和英文切换页，单行 GitHub Release URL 安装，实核远端资产和隔离安装。

## Capabilities

### New Capabilities
- `platform-runtime`: macOS/Windows 原生 CLI 启动、保护方式、路径与进程生命周期。
- `package-distribution`: 双语首页、单行预构建安装、发布资产及远端验证。

### Modified Capabilities
- `cli-account-isolation`: 明确隔离约束为 Host 的自身账号识别和凭据注入边界，不附加 OS 禁读规则。

## Impact

影响 Host 启动、账号与目录上下文、辅助入口、Windows CI、构建资产、README/README.en.md 和发布文档；公开偏好/Worker/Gateway 协议保持兼容。不修改 Harness 核心，不删除或切换真实账号，不重新生成模型内容。用户已授权 GitHub 更新和 Release，本轮允许推送本次提交，既有未提交素材整理保留。
