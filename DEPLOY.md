# ZeroG Code 全栈部署指南 (Deployment Guide)

本文档覆盖 **ZeroG Code** 全栈 4 大组件的完整安装、配置与验证步骤：
1. **Antigravity CLI (`agy`)** — 本地 CLI 引擎底座
2. **ZeroG Code 插件（VS Code / Cursor）** — 预打包文件 [`dist/zerog-code-0.7.7.vsix`](dist/zerog-code-0.7.7.vsix)
3. **本地 Web Bridge 守护进程 + MCP 服务** — [`web-bridge/`](web-bridge/)（运行于 `http://127.0.0.1:18765`）
4. **Chrome MV3 浏览器拓展（`ZeroG Code — Gemini Web Bridge`）** — 预打包文件 [`dist/zerog-code-chrome-extension-2.6.7.zip`](dist/zerog-code-chrome-extension-2.6.7.zip)（解压源码同见 [`web-bridge/chrome-extension/`](web-bridge/chrome-extension/)）

> 发布仓库（公开）：[https://github.com/orinplin99-maker/ZeroG-Code-release](https://github.com/orinplin99-maker/ZeroG-Code-release) · 源码仓库：[https://github.com/orinplin99-maker/ZeroG-Code](https://github.com/orinplin99-maker/ZeroG-Code)

---

## 一、环境前置要求

| 依赖 | 最低版本 / 说明 | 安装命令（Windows） |
|---|---|---|
| **Windows** | Windows 10 / 11（PowerShell 5.1 或 7+） | 系统自带 |
| **Node.js** | `>= 18`（运行 Web Bridge 与 MCP） | `winget install OpenJS.NodeJS.LTS` |
| **VS Code / Cursor** | VS Code `>= 1.85`（需 `code` 或 `cursor` 在 PATH） | 官网安装 |
| **Google Chrome** | 需登录可用 `https://gemini.google.com` 的账号（仅 Web 通道需要） | 官网安装 |
| **Antigravity CLI (`agy`)** | 需安装并完成浏览器登录 | `irm https://antigravity.google/cli/install.ps1 \| iex` |

---

## 二、预打包产物清单（开箱即用，无需编译）

克隆或下载本仓库后，可直接使用以下最新安装包：

| 产物路径 | 组件 | 版本 | 用途 |
|---|---|---|---|
| `dist/zerog-code-0.7.7.vsix` | ZeroG Code VS Code / Cursor 插件 | `0.7.7` | 离线安装到 VS Code / Cursor（Extension ID：`orinplin99-maker.zerog-code`） |
| `dist/zerog-code-chrome-extension-2.6.7.zip` | ZeroG Code — Gemini Web Bridge Chrome 拓展 | `2.6.7` | 解压后在 Chrome `chrome://extensions/` 加载 |
| `skills/zerog-code-deploy/` | AI Agent 自动化部署 Skill | 最新 | 交给 Antigravity / Claude Code 一键全自动部署 |

---

## 三、部署方式（三选一）

### 方式 1：交给 AI Agent 全自动部署（最推荐）

1. 将仓库中的 [`skills/zerog-code-deploy/`](skills/zerog-code-deploy/) 目录复制到对应技能目录：
   - **Antigravity**：`%USERPROFILE%\.gemini\config\skills\zerog-code-deploy`
   - **Claude Code**：`%USERPROFILE%\.claude\skills\zerog-code-deploy`
2. 直接对 AI 说：
   > **“帮我部署 ZeroG Code”**（或把 `skills/zerog-code-deploy/SKILL.md` 发给 AI）
3. AI 会按 [`skills/zerog-code-deploy/SKILL.md`](skills/zerog-code-deploy/SKILL.md) 自动完成 Node.js / `agy` 检查、VSIX 安装、Web Bridge 启动、MCP 注册，并引导你完成 Chrome 拓展加载与联通校验。

---

### 方式 2：Windows PowerShell 一键脚本部署（推荐）

在克隆好的 `ZeroG-Code` 仓库根目录执行：

```powershell
# 1. 标准全栈部署到 VS Code（缺少 agy 时自动安装 + 安装预打包 VSIX + 部署并启动 Web Bridge + 注册 MCP + 安装部署 Skill + 打开 Chrome 拓展目录）
powershell -ExecutionPolicy Bypass -File .\skills\zerog-code-deploy\scripts\deploy.ps1 -UsePrebuilt -InstallSkill -OpenChromeExt

# 2. 同时装入 VS Code 和 Cursor（缺少 agy 同样默认自动安装；如不想自动装 agy 可加 -NoInstallAgy）
powershell -ExecutionPolicy Bypass -File .\skills\zerog-code-deploy\scripts\deploy.ps1 -Editor code,cursor -UsePrebuilt -InstallSkill -OpenChromeExt

# 3. 从源码现编 VSIX 后全栈部署（去掉 -UsePrebuilt 即可）
powershell -ExecutionPolicy Bypass -File .\skills\zerog-code-deploy\scripts\deploy.ps1 -InstallSkill -OpenChromeExt

# 4. 仅更新 Web Bridge 与 Chrome 拓展（跳过 VS Code 插件重装）
powershell -ExecutionPolicy Bypass -File .\skills\zerog-code-deploy\scripts\deploy.ps1 -SkipVsCode -SkipAuthCheck
```

> **新机零前置保障**：`deploy.ps1` 检测到本机未安装 `agy` CLI 时会**自动调用官方安装脚本完成部署**，并且会先把 VSIX、Web Bridge、Chrome 拓展和 MCP 全部落盘，最后再检测登录态；若刚装完尚未登录，只需在终端执行一次 `agy` 完成浏览器登录即可，无需重跑部署脚本。
>
> **安全升级保障**：`deploy.ps1` 会自动卸载历史旧 ID（`local.antigravity-tabs`、`orinpl.ccweb-for-antigravity`）避免命令冲突，更新前自动停止旧 Web Bridge，且**绝不覆盖**用户的 `state.json`、`web_usage.json`、`LOCAL_TOOL_INDEX.md` 和 `bridge.config.json`。

脚本执行完后，按下方 **第四步** 加载一次 Chrome 拓展即可。

---

### 方式 3：纯手动离线部署（使用 `dist/` 预打包文件）

#### 1) 安装并登录 Antigravity CLI (`agy`)
```powershell
irm https://antigravity.google/cli/install.ps1 | iex
agy
```
按终端提示在浏览器完成登录后，可执行 `agy -p /usage --output-format json` 确认返回 `SUCCESS`。

#### 2) 安装 ZeroG Code 插件（VS Code / Cursor）
```powershell
# VS Code
code --install-extension .\dist\zerog-code-0.7.7.vsix --force

# Cursor（可选）
cursor --install-extension .\dist\zerog-code-0.7.7.vsix --force
```
也可在 VS Code 左侧 **Extensions** 面板右上角 `...` → **Install from VSIX...** 中选择 `dist/zerog-code-0.7.7.vsix`。

#### 3) 部署并启动本地 Web Bridge 与 MCP 服务
```powershell
$bridgeDst = "$env:USERPROFILE\.gemini\web-bridge"
New-Item -ItemType Directory -Force "$bridgeDst\chrome-extension" | Out-Null

# 复制 Web Bridge 核心脚本
Copy-Item .\web-bridge\server.mjs, .\web-bridge\mcp-server.mjs, .\web-bridge\start-bridge.ps1, .\web-bridge\stop-bridge.ps1, .\web-bridge\README.md $bridgeDst -Force

# 解压最新 Chrome 拓展包到运行时目录
Expand-Archive -Path .\dist\zerog-code-chrome-extension-2.6.7.zip -DestinationPath "$bridgeDst\chrome-extension" -Force

# 后台独立启动 Web Bridge（监听 127.0.0.1:18765，VS Code Reload Window 不会杀掉）
& "$bridgeDst\start-bridge.ps1"
```

在 `%USERPROFILE%\.gemini\config\mcp_config.json` 中注册 `gemini-web-agent`（若文件不存在可新建）：
```json
{
  "mcpServers": {
    "gemini-web-agent": {
      "command": "node",
      "args": [
        "C:\\Users\\<你的用户名>\\.gemini\\web-bridge\\mcp-server.mjs"
      ],
      "env": {
        "WEB_BRIDGE_PORT": "18765"
      }
    }
  }
}
```

---

## 四、加载 Chrome 浏览器拓展（Chrome 安全机制要求手动操作一次）

1. 在 Chrome 地址栏打开 `chrome://extensions/`。
2. 打开右上角 **开发者模式（Developer mode）**。
3. 点击左上角 **加载已解压的扩展程序（Load unpacked）**，选择：
   ```text
   %USERPROFILE%\.gemini\web-bridge\chrome-extension
   ```
   > 也可以把 `dist/zerog-code-chrome-extension-2.6.7.zip` 解压到任意固定目录后选择该目录。
   > 若此前已加载过旧版拓展，覆盖文件后只需在拓展卡片上点击 **刷新 ↻** 即可。
4. 在 Chrome 中打开 `https://gemini.google.com` 并确保已登录。

---

## 五、端到端验证

完成上述步骤后，运行以下两条校验命令：

```powershell
# 1. 验证 VS Code 插件版本（应为 orinplin99-maker.zerog-code@0.7.7，且无旧版残留）
code --list-extensions --show-versions | Select-String "zerog-code|ccweb|antigravity-tabs"

# 2. 验证本地 Web Bridge 与 Chrome 拓展实时握手
Invoke-RestMethod http://127.0.0.1:18765/status | Select-Object ok, browserOnline, cwd, version
```

预期正常输出：
- `orinplin99-maker.zerog-code@0.7.7`
- `ok: True` 且 `browserOnline: True`

随后在 VS Code / Cursor 中：
1. 按 `Ctrl+Shift+P` 执行 **`Developer: Reload Window`**。
2. 按 `Ctrl+Shift+Alt+N`（或点击底部状态栏 **`ZeroG`** 按钮）新建对话标签页。
3. 快速冒烟测试：
   - **本地 CLI 通道**：输入 `/usage` 或直接发送消息。
   - **网页双擎通道**：输入 `/web`（或在 `/model` 中选择 `🌐 Web · 4 Neon` / `4 Carbon` / `4 Hydrogen`），验证正常回复与本地工具调用。

---

## 六、开发者：从源码重新打包

仓库内置纯 PowerShell 打包脚本（无需 `npm`、`vsce` 或联网）：

```powershell
# 重新打包 VS Code / Cursor 插件 -> dist/zerog-code-<ver>.vsix
./scripts/build_vsix.ps1

# 重新打包 Chrome MV3 拓展 -> dist/zerog-code-chrome-extension-<ver>.zip
./scripts/build_chrome_ext.ps1
```

---

## 七、常见问题排查

| 现象 | 处理方法 |
|---|---|
| `browserOnline: False` | 检查 `chrome://extensions/` 中 **ZeroG Code — Gemini Web Bridge** 是否已启用且无 Service Worker 报错；点卡片上的 **刷新 ↻**，并刷新打开的 `gemini.google.com` 标签页。 |
| 端口 `18765` 异常或代码更新未生效 | 执行 `& "$env:USERPROFILE\.gemini\web-bridge\stop-bridge.ps1"` 后再执行 `& "$env:USERPROFILE\.gemini\web-bridge\start-bridge.ps1"`，查看日志 `%USERPROFILE%\.gemini\web-bridge\bridge.log`。 |
| `agy -p /usage` 报 `User location is not supported` | 网络出口地区限制问题，切换代理节点后重试。 |
| 希望 Gemini Web 了解私有项目结构 / Skill | 在 `%USERPROFILE%\.gemini\web-bridge\` 下新建 `LOCAL_TOOL_INDEX.md`（支持 `${WORKSPACE}` 占位符），`server.mjs` 会在 Web 首轮对话自动注入。 |
