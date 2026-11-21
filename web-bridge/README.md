# ZeroG Code — 本地 Web Bridge 与 Chrome 拓展

本目录包含驱动 ZeroG Code **🌐 Gemini Web** 通道（`/web`、`/sync`、`/pull`、网页端模型/思考强度同步及零额外 Token 本地 ReAct 工具）的两个运行时组件：

| 路径 | 职责 |
|---|---|
| `server.mjs` | 本地 HTTP 守护进程（`127.0.0.1:18765`），负责编排 `json:local-tool` ReAct 循环、模式权限审批、串行化网页端发送与按会话路由 |
| `harness/` | 对话治理模块（模式权限、上下文路由、循环防护与 Steer 纠偏、子代理角色与任务状态） |
| `mcp-server.mjs` | 可选的 stdio MCP 服务，向 `agy` / Claude Code 暴露 `gemini_web_ask` 与 `gemini_web_agent` 工具 |
| `start-bridge.ps1` / `stop-bridge.ps1` | Windows 后台守护进程启停脚本（VS Code 重载窗口后仍保持常驻） |
| `start-bridge.sh` / `stop-bridge.sh` | macOS / Linux 对应的后台守护进程启停脚本（与 PowerShell 版保持一致的 PID 与端口行为） |
| `chrome-extension/` | 与 `gemini.google.com` 通信的 Chrome Manifest V3 拓展（`ZeroG Code — Gemini Web Bridge`，v2.7.0；预打包压缩包位于 `../dist/zerog-code-chrome-extension-2.7.0.zip`） |

## 运行目录

ZeroG Code 默认从以下路径查找并连接本地桥接守护进程：

```text
%USERPROFILE%\.gemini\web-bridge\   # Windows
~/.gemini/web-bridge/                # macOS / Linux
```

推荐使用 `skills/zerog-code-deploy/scripts/deploy.ps1`（Windows）或 `deploy.sh`（macOS / Linux）自动安装并启动（详见 [`../DEPLOY.md`](../DEPLOY.md)）；也可以手动将本目录复制到上述路径后执行：

```powershell
& "$env:USERPROFILE\.gemini\web-bridge\start-bridge.ps1"
```

## 加载 Chrome 拓展

1. 打开 Chrome 并访问 `chrome://extensions/`。
2. 开启右上角的**开发者模式**。
3. 点击**加载已解压的扩展程序**，选择：
   ```text
   %USERPROFILE%\.gemini\web-bridge\chrome-extension
   ```
   *（macOS / Linux 选 `~/.gemini/web-bridge/chrome-extension`，或将 `../dist/zerog-code-chrome-extension-2.7.0.zip` 解压到固定目录后选择该目录。）*
4. 在 Chrome 中登录 `https://gemini.google.com`。
5. 验证本地桥接服务是否已成功连上浏览器：
   ```powershell
   Invoke-RestMethod [http://127.0.0.1:18765/status](http://127.0.0.1:18765/status) | Select-Object ok, browserOnline, cwd
   ```

> **可选：可信发送开关（默认关闭）**：为降低风控暴露并避免弹出 Chrome 调试横幅，拓展默认仅使用普通合成点击发送，**不会**调用 `chrome.debugger`。仅当新版 Gemini 页面忽略普通点击导致无法发出消息时，再在页面右下角浮窗中手动勾选 **「可信发送」**。

## 重新打包 Chrome 拓展

```powershell
../scripts/build_chrome_ext.ps1   # 输出 ../dist/zerog-code-chrome-extension-2.7.0.zip
```

## 本地接口访问控制

Web Bridge 仅监听 `127.0.0.1`，默认仅放行无 `Origin` 的本机原生客户端（如 VS Code 插件）、浏览器拓展（`chrome-extension://`）以及 `https://gemini.google.com`（content script 兜底请求通道）。其余任意网页来源一律返回 `403`，且所有 `POST` 请求必须使用 `application/json`（否则返回 `415`），防止任意浏览的网页调用 `/ask` 执行本机命令。如需放行额外来源，可在 `bridge.config.json` 中配置 `"allowedOrigins": ["https://example.com"]` 或设置环境变量 `WEB_BRIDGE_ALLOWED_ORIGINS`（逗号分隔）。

## 可选配置：自定义本地工具索引与显式路径配置（`bridge.config.json`）

- 可在 `%USERPROFILE%\.gemini\web-bridge\` 下放置 `LOCAL_TOOL_INDEX.md`，通过 `get_context`（`{"kind": "index"}`）按需提供项目专属的工具与文档索引，避免首轮对话提示词臃肿（支持 `${WORKSPACE}` 占位符展开）。
- 可在 `%USERPROFILE%\.gemini\web-bridge\` 下放置可选的 `bridge.config.json`，无需环境变量即可显式配置各项路径：
  ```json
  {
    "port": 18765,
    "mcpConfigPath": "~/.gemini/config/mcp_config.json",
    "mcpCacheDir": "~/.gemini/antigravity-cli/mcp",
    "mcpManagerPath": "~/.gemini/web-bridge/mcpManager.js",
    "skillDirs": ["~/.gemini/config/skills", "~/.claude/skills"],
    "rulesDir": "~/.gemini/config/rules",
    "memoryDir": "~/.gemini/memory",
    "toolIndexFile": "~/.gemini/web-bridge/LOCAL_TOOL_INDEX.md",
    "allowedOrigins": [],
    "agyExecutable": "",
    "skipDirs": []
  }
  ```
