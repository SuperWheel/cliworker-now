# Spec Delta

## Purpose

规定插件在 macOS 与 Windows 中如何识别并启动已安装的原生 CLI、使用其自身保护与权限模式、解析对应系统路径并确认进程清理，确保跨平台声明来自实际运行证据。

## ADDED Requirements

### Requirement: CLI 原生保护方式
插件 SHALL 使用各 CLI 实际支持的原生权限和计划模式，不额外套插件操作系统进程沙箱。宿主授权、项目及模型选择边界 MUST 保持；原生不支持的只读模式不得通过普通写入模式冒充。

#### Scenario: 原生任务启动
- **WHEN** 用户授权并选择已安装 CLI、模型和强度后启动任务
- **THEN** 只传该 CLI 实际支持的原生参数，不依赖 macOS sandbox-exec，不静默换用 CLI 或权限模式

#### Scenario: 只读能力缺失
- **WHEN** 请求原生 CLI 不支持的只读任务模式
- **THEN** 保留明确拒绝，不添加不存在的开关或绕过宿主限制

### Requirement: Windows 原生入口与路径
插件 SHALL 在 Windows 按实际官方安装入口启动 exe、Node 和 Python CLI，参数保持独立 argv，不拼接 shell。盘符与 UNC、当前原生账号目录和安装资产 MUST 按该平台解析；未知 batch 形态短错误拒绝。

#### Scenario: npm Windows shim
- **WHEN** 官方固定 npm shim 指向可核验的自身 JavaScript 入口
- **THEN** 使用 Node 与该入口启动，CLI 参数按原数组保留，包含空格/中文/引号的参数不触发 shell 执行

#### Scenario: 不受支持的入口
- **WHEN** 自定义 batch 包含无法确认的程序或逻辑
- **THEN** 拒绝并显示短原因，不以 cmd /c 执行任意 batch

#### Scenario: 当前认证路径
- **WHEN** 当前原生登录位于 Windows 盘符或 UNC 路径
- **THEN** 状态和执行读取相同 CLI 的当前来源，不生成错误盘符路径或复制旧认证

### Requirement: 跨平台进程范围清理
Windows 任务 SHALL 使用可确认后代归属的 Host 进程管理能力；停止、取消与清理失败语义保持一致。测试 MUST 验证实际 Windows 进程范围，不能只用 mock 证明后代退出。

#### Scenario: Windows 任务取消
- **WHEN** 用户停止或取消启动了后代的任务
- **THEN** 等待所有受管理进程退出再报告停止成功；无法确认时阻止冲突任务

#### Scenario: 关闭账号终端
- **WHEN** 用户关闭原生账号菜单
- **THEN** 清理属于该菜单的进程和临时状态，持久账号和其他终端保留
