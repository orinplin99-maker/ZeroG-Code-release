# ZeroG Code — 官方发布仓库

<p align="center">
  <img src="media/icon.png" width="112" alt="ZeroG Code" />
</p>

本仓库提供 **ZeroG Code** 的预打包发布产物与全栈一键部署工具 —— **ZeroG Code** 是一款面向 VS Code / Cursor 的 Claude Code 风格多标签 AI 编程工作区，基于 **Antigravity CLI（`agy acp`）** 驱动，并深度集成 **Gemini Web Bridge**，实现本地 CLI 与浏览器端 Gemini 的无缝双通道协同与零额外额度本地工具闭环。

> **免责声明**：本项目为**非官方**社区插件，与 Google 无隶属关系，亦未获其官方背书。文中提及的 “Antigravity” 仅用于说明与 Antigravity CLI（`agy`）的兼容性。
>
> 发布仓库：[https://github.com/orinplin99-maker/ZeroG-Code-release](https://github.com/orinplin99-maker/ZeroG-Code-release) · 完整部署指南：[**DEPLOY.md**](DEPLOY.md) · 更新日志：[**CHANGELOG.md**](CHANGELOG.md)

---

## 最新版本（`v0.7.10`）

| 交付产物 | 组件说明 | 版本 |
|---|---|---|
| `dist/zerog-code-0.7.10.vsix` | ZeroG Code VS Code / Cursor 插件安装包（`orinplin99-maker.zerog-code`） | `0.7.10` |
| `dist/zerog-code-chrome-extension-2.7.0.zip` | ZeroG Code — Gemini Web Bridge（Chrome MV3 浏览器拓展压缩包） | `2.7.0` |
| `web-bridge/` | 本地 Web Bridge 守护进程（`127.0.0.1:18765`）、`harness/` 编排模块、MCP 服务及解压版 Chrome 拓展 | `2.7.0` |
| `skills/zerog-code-deploy/` | 自动化部署 Skill 与一键安装脚本（Windows：`deploy.ps1`；macOS / Linux：`deploy.sh`） | `0.7.10` |
| `release.json` | 发布元数据与 SHA-256 校验值 | `0.7.10` |

---

## 核心特性

- **多标签并行工作区**：右侧编辑器分组独立并行多会话，标签标题自动跟随主题，窗口重载后完整恢复。
- **CLI + Gemini Web 双通道协同（`/web`、`/cli`、`/sync`、`/pull`）**：单标签内无缝切换本地 `agy` CLI 与浏览器端 `gemini.google.com`（`4 Neon`、`4 Carbon`、`4 Hydrogen`），本地零 Token 消耗执行代码读写/检索/命令/MCP 与多并发 `web_subagent`，并支持无 CLI 时的 Web-only 独立模式。
- **新一代上下文治理与零主模型额度 `/compact`**：实时展示 Web 窗口估算上下文水位，支持默认「懒换窗（`lazy`）」零高配额度消耗压缩、`4 Hydrogen (low)` 后台轻量语义蒸馏（失败自动降级本地确定性压缩）、外部完整历史归档指针（按需 `read_file` 回溯）与自动无损换窗续跑。
- **模式硬隔离与运行中纠偏**：支持 `Ask` / `Accept edits` / `Plan` / `⚡ Auto` 四态权限控制（`Shift+Tab` 切换）、Ask 模式写操作审批弹窗、运行中 `⚡ Steer` 实时插话纠偏与失败熔断。
- **完整生产力套件**：毫秒级 `/resume` 历史检索、`/fork` 会话分叉、`/mcp` 服务管理、`/usage` 5h/周配额与上下文水位面板、可点击代码行号链接、内联 Diff 预览及截图粘贴。

---

## 快速安装

### 方式 1：一键全栈部署（推荐）

克隆本仓库后，在仓库根目录执行对应平台脚本（会自动检测/补装 `agy` CLI、安装 VSIX 插件、部署并启动本地 Web Bridge、注册 MCP）：

**Windows (PowerShell)：**
```powershell
# 部署到 VS Code
powershell -ExecutionPolicy Bypass -File .\skills\zerog-code-deploy\scripts\deploy.ps1 -UsePrebuilt -InstallSkill -OpenChromeExt

# 同时部署到 VS Code 与 Cursor
powershell -ExecutionPolicy Bypass -File .\skills\zerog-code-deploy\scripts\deploy.ps1 -Editor code,cursor -UsePrebuilt -InstallSkill -OpenChromeExt
```

**macOS / Linux：**
```bash
# 部署到 VS Code
./skills/zerog-code-deploy/scripts/deploy.sh --install-skill --open-chrome-ext

# 同时部署到 VS Code 与 Cursor
./skills/zerog-code-deploy/scripts/deploy.sh --editor code,cursor --install-skill --open-chrome-ext
```

随后完成一次性 Chrome 拓展加载：
1. 打开 Chrome 访问 `chrome://extensions/` 并开启右上角 **开发者模式**。
2. 点击 **加载已解压的扩展程序** → 选择 `%USERPROFILE%\.gemini\web-bridge\chrome-extension`（macOS / Linux 为 `~/.gemini/web-bridge/chrome-extension`）。
3. 在浏览器登录 `https://gemini.google.com`。
4. 在 VS Code / Cursor 中执行 **`Developer: Reload Window`**，按 `Ctrl+Shift+Alt+N`（或点击左下角状态栏 **ZeroG** 按钮）即可开始使用。

### 方式 2：AI Agent 自动部署

将 `skills/zerog-code-deploy/` 复制到 `~/.gemini/config/skills/zerog-code-deploy`（或 `~/.claude/skills/zerog-code-deploy`），然后直接对你的 AI Agent 说 **“部署 ZeroG Code”** 即可自动完成全链路安装与校验。

### 方式 3：手动离线安装

完整的分步离线安装步骤、环境校验命令与常见问题排查请参阅 [**DEPLOY.md**](DEPLOY.md)。
