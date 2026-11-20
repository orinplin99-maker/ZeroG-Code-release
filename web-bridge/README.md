# ZeroG Code — Local Web Bridge & Chrome Extension

This directory contains the two runtime pieces that power ZeroG Code's **🌐 Gemini Web** channel (`/web`, `/sync`, `/pull`, Web model/effort sync, and zero-token local ReAct tools):

| Path | Role |
|---|---|
| `server.mjs` | Local HTTP daemon (`127.0.0.1:18765`) orchestrating `json:local-tool` ReAct loops, serialized web sends, and per-session routing |
| `mcp-server.mjs` | Optional stdio MCP server exposing `gemini_web_ask` and `gemini_web_agent` to `agy` / Claude Code |
| `start-bridge.ps1` / `stop-bridge.ps1` | Windows background daemon start/stop helpers (survives VS Code Reload Window) |
| `chrome-extension/` | Chrome Manifest V3 extension (`ZeroG Code — Gemini Web Bridge`, v2.6.8) communicating with `gemini.google.com` (prebuilt zip: `../dist/zerog-code-chrome-extension-2.6.8.zip`) |

## Runtime Location

ZeroG Code looks for the bridge daemon at:

```text
%USERPROFILE%\.gemini\web-bridge\
```

Use `skills/zerog-code-deploy/scripts/deploy.ps1` (recommended — see [`../DEPLOY.md`](../DEPLOY.md)) to install and start it automatically, or copy this folder manually to `%USERPROFILE%\.gemini\web-bridge\` and run:

```powershell
& "$env:USERPROFILE\.gemini\web-bridge\start-bridge.ps1"
```

## Loading the Chrome Extension

1. Open Chrome and navigate to `chrome://extensions/`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select:
   ```text
   %USERPROFILE%\.gemini\web-bridge\chrome-extension
   ```
   *(Or extract `../dist/zerog-code-chrome-extension-2.6.8.zip` to a permanent folder and select that folder.)*
4. Sign in to `https://gemini.google.com` in Chrome.
5. Verify the bridge sees the browser:
   ```powershell
   Invoke-RestMethod http://127.0.0.1:18765/status | Select-Object ok, browserOnline, cwd
   ```

## Repackaging the Chrome Extension

```powershell
../scripts/build_chrome_ext.ps1   # Outputs ../dist/zerog-code-chrome-extension-2.6.8.zip
```

## Optional: Custom Local Tool Index & Explicit Path Config (`bridge.config.json`)

- Place a `LOCAL_TOOL_INDEX.md` inside `%USERPROFILE%\.gemini\web-bridge\` to expose project-specific tool/doc notes lazily via `get_context` (`{"kind": "index"}`) without bloating the first Web turn (supports `${WORKSPACE}` placeholder expansion).
- Place an optional `bridge.config.json` inside `%USERPROFILE%\.gemini\web-bridge\` to configure paths explicitly without environment variables:
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
    "agyExecutable": "",
    "skipDirs": []
  }
  ```
