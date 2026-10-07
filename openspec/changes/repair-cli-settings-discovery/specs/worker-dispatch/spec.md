# Spec Delta

## ADDED Requirements

### Requirement: OMP 与 Pi 独立身份
工具指引、账号、模型和执行入口 SHALL 将 OMP（Oh My Pi）与 Pi Coding Agent 标为独立 CLI；相同模型或共享桥接实现 MUST 不改变用户选择。执行入口 SHALL 校验所选 CLI 身份和所需原生能力，错误入口在登录、发现或派遣前拒绝。

#### Scenario: 相同模型独立派遣
- **WHEN** 用户分别指定 OMP 和 Pi 使用同名模型
- **THEN** 选择、账号、偏好及会话保持对应 CLI 身份，不推断为同一 CLI

#### Scenario: 错误的程序路径
- **WHEN** OMP 设置指向 Pi 或 Pi 设置指向 OMP
- **THEN** 显示身份不匹配并拒绝启动，不静默替换程序

#### Scenario: 原生安装版本
- **WHEN** 当前原生 Pi 安装满足已核验的桥接能力
- **THEN** 发现、登录和执行使用同一安装；不暗中优先另一旧版本的私有安装
