# Design

## Context

安装 CLI 的 plugin add 原样传入 pnpm；官方 Desktop 提供跨平台 dsh 命令管理。仓库无 npm 发布认证且 private=true，因此使用固定 Release tarball URL。Windows Harness 有普通 spawn 的 Job owner，ConPTY 当前不在 Job containment 内。当前外层 Seatbelt 策略不能照搬到 Windows；用户已明确撤销该外层保护需求。

## Goals / Non-Goals

目标：取消插件 OS 进程沙箱，保持自身账号精确识别、原生保护、可解释错误、宏观授权及取消清理，完成 Windows 启动层与双语公开交付。
不新增 Windows AppContainer、全局 ACL 改动或权限绕过，不把运行层测试说成所有第三方 CLI/模型已真实推理成功。

## Decisions

- 任务及目录运行使用各 CLI 原生参数。保留只读/plan 模式与无能力时的拒绝；不再使用 sandbox-exec 或为认证/退出套附加读写、禁网策略。原生 CLI 对文件操作的权限由其自身负责。
- Host 仍只读各 CLI 自己的原生/插件账号和 API 配置；清理通用凭据环境，不注入 dsh 密钥，不用其他 CLI 认证作为本 CLI 登录。保留来源版本、账号换号/退出重检、模型与强度交集，私有状态和旧会话保持。
- Windows 后端集中归一化官方 Node/Bun/npm shim 和实际 exe。仅解析已确认固定入口，未知 batch 拒绝；参数独立数组，不经过 cmd /c 或拼 shell。Hermes Windows 使用其官方 exe/固定 Python shim，不猜虚构 Python 路径。
- Windows 任务走 Harness 普通 spawn 的 Job owner；账号交互用原生终端并按实际进程范围确认退出。路径从 parse(path).root 遍历，支持盘符/UNC。MiMo 登录直接绑定当前原生认证路径，不复制凭据，不要求管理员开启 symlink。
- 宿主安装与 CLI 原生支持分开记录：macOS/Windows 插件运行层均验证；第三方 CLI 必须有对应系统的有效安装，未获得模型选型授权不生成。
- README.md 为默认中文入口，README.en.md 提供完整英文与双向切换；安装代码块只一行固定版本 tarball URL，不加入 # 备注。预构建包覆盖双方文档和动态运行资产。
- GitHub Actions Windows 临时账号/本机服务验证实际 Node、路径、进程与安装合同；macOS 做回归及隔离 preview。正式包与远端重下载逐字节匹配，独立 DSH_HOME 验证 URL 安装，不改真实 Desktop 的安装来源。

## Risks / Trade-offs

- 取消外层后 CLI 能读取更多原生可访问文件，这是用户本轮已选择的行为；Host 自身识别和凭据投影继续受限，不能再承诺操作系统级禁读。
- Windows launcher 与 Vendor 版本可能变化：按当前实际入口核验，未知形态短错误拒绝，不猜参数。
- 同源认证链接/路径初始化可能恢复旧账号：拒绝凭据副本，退出和换号仍以当前来源重读为准。
- Windows 后代清理需真平台证据；仅 mock 不能过发布门槛。无原生 Windows 安装的第三方工具保留其依赖限制。

## Migration Plan

按阶段本地提交并在专用验证分支运行 Windows CI，修复失败后执行 macOS 回归/隔离构建。无活动任务时更新本机 Desktop，核对原数据。最终同步/归档规格，fast-forward 更新 GitHub main、标记 v0.6.15 并发布包含校验文件的 Release；远端资源与 URL 安装验证完毕再交付。保留用户未提交图标/文档改动，回退只替换插件构建。
