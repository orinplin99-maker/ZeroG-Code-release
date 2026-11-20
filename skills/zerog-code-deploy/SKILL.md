---
name: zerog-code-deploy
description: End-to-end deployment skill for ZeroG Code (orinplin99-maker.zerog-code): verifies Node.js, automatically installs Antigravity CLI (agy) when missing, installs or rebuilds the ZeroG Code VS Code / Cursor VSIX extension (dist/zerog-code-0.7.8.vsix), deploys & starts the local Gemini Web Bridge daemon (~/.gemini/web-bridge), registers the gemini-web-agent MCP server, and guides loading & verifying the Chrome MV3 extension (dist/zerog-code-chrome-extension-2.6.8.zip / web-bridge/chrome-extension). Use when the user asks to "deploy ZeroG Code", "部署 ZeroG Code", "新电脑安装 ZeroG Code", "安装 ZeroG Code 插件和浏览器拓展", "配置 Web Bridge 和 Chrome 拓展", or "fix ZeroG Code web bridge / chrome extension".
---

# ZeroG Code — Full-Stack Deployment SOP

Deploys all four components of **ZeroG Code** on Windows from [https://github.com/orinplin99-maker/ZeroG-Code-release](https://github.com/orinplin99-maker/ZeroG-Code-release). **If `agy` CLI is not installed yet, `deploy.ps1` automatically installs it via the official installer (`irm https://antigravity.google/cli/install.ps1 | iex`)** before deploying the remaining components. For human-readable manual instructions, see [`DEPLOY.md`](../../DEPLOY.md).

| Component | Source / Prebuilt Package in Repo | Runtime Target |
|---|---|---|
| **Antigravity CLI (`agy`)** | Auto-installed automatically when missing (`irm https://antigravity.google/cli/install.ps1 \| iex`) | `%LOCALAPPDATA%\agy\bin\agy.exe` |
| **ZeroG Code Extension** | Prebuilt `dist/zerog-code-0.7.8.vsix` (source: repo root + `scripts/build_vsix.ps1`) | VS Code / Cursor (`orinplin99-maker.zerog-code`) |
| **Local Web Bridge + MCP** | `web-bridge/` (`server.mjs`, `mcp-server.mjs`, `*.ps1`) + shared MCP helpers | `%USERPROFILE%\.gemini\web-bridge\` (`http://127.0.0.1:18765`) + `~/.gemini/config/mcp_config.json` |
| **Chrome MV3 Extension** | Prebuilt `dist/zerog-code-chrome-extension-2.6.8.zip` & unpacked `web-bridge/chrome-extension/` (builder: `scripts/build_chrome_ext.ps1`) | `%USERPROFILE%\.gemini\web-bridge\chrome-extension\` (loaded unpacked in Chrome) |

---

## Step 1: Run the One-Shot Deploy Script

From inside the cloned `ZeroG-Code` repository (or anywhere with `-RepoDir <repo-path>` / `-AutoClone`):

```powershell
# Standard full-stack deploy to VS Code (auto-installs agy if missing, deploys VSIX + Web Bridge + MCP, checks sign-in)
& "<skill-dir>\scripts\deploy.ps1" -UsePrebuilt -InstallSkill -OpenChromeExt

# Deploy into both VS Code & Cursor on a brand-new machine (agy auto-installs by default):
& "<skill-dir>\scripts\deploy.ps1" -Editor code,cursor -UsePrebuilt -InstallSkill -OpenChromeExt

# Standalone skill without local repo yet (clones ZeroG-Code & auto-installs agy automatically)
& "<skill-dir>\scripts\deploy.ps1" -AutoClone -UsePrebuilt -InstallSkill

# Update Web Bridge & Chrome extension files only (skip VS Code VSIX)
& "<skill-dir>\scripts\deploy.ps1" -SkipVsCode -SkipAuthCheck
```

### Interpret Exit Codes & Act

| Exit Code | Meaning | Required Agent Action |
|---|---|---|
| `0` | All components deployed and `agy` signed in | Proceed to **Step 2 (Chrome Extension)** and **Step 3 (Verification)**. |
| `1` | Node.js `< 18` or missing | Ask user to install Node.js LTS (`winget install OpenJS.NodeJS.LTS`), open a new terminal, and rerun. |
| `2` | `agy` CLI auto-install failed (or `-NoInstallAgy` was passed) | Check network/proxy, or ask user to run `irm https://antigravity.google/cli/install.ps1 \| iex`, then rerun. |
| `3` | **All components are already deployed**, but `agy` is not signed in yet | **Sign-in is interactive.** Ask user to run `agy` in a terminal (or VS Code Command Palette → `ZeroG: Sign In to Antigravity CLI (agy)`) to finish browser login; no need to re-run full deploy. (If output mentions `User location is not supported`, it is a network/region proxy issue.) |
| `4` | VSIX build / lookup failed | Verify `package.json` is valid JSON and `media/icon.png` exists, or verify `dist/zerog-code-*.vsix`. |
| `5` | VS Code / Cursor install verification failed | Check `code` / `cursor` is on PATH, or run `code --install-extension dist\zerog-code-0.7.8.vsix --force`. |
| `6` | Local Web Bridge failed to start | Inspect `%USERPROFILE%\.gemini\web-bridge\bridge.log` and check port `18765` conflicts. |
| `7` | `ZeroG-Code` repo not found | Pass `-RepoDir <path>` or rerun with `-AutoClone`. |

> **Safe upgrade guarantee**: `deploy.ps1` auto-installs `agy` when missing (use `-NoInstallAgy` to disable), automatically removes legacy extension IDs (`local.antigravity-tabs`, `orinpl.ccweb-for-antigravity`) to prevent `agyTabs.*` command collisions, stops the old bridge before updating `server.mjs`, and **never overwrites** user state/config files (`state.json`, `web_usage.json`, `LOCAL_TOOL_INDEX.md`, `bridge.config.json`).

---

## Step 2: Load the Chrome Extension (Manual — Required Once by Chrome Security)

Chrome does not allow silent script installation of unpacked extensions. Guide the user through these 4 quick steps (or run with `-OpenChromeExt` to open both Explorer and Chrome):

1. Open Chrome and visit `chrome://extensions/`.
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked** and choose:
   ```text
   %USERPROFILE%\.gemini\web-bridge\chrome-extension
   ```
   *(Alternative: unzip `dist/zerog-code-chrome-extension-2.6.8.zip` to a permanent folder and select that folder. If upgrading an existing installation, just click **Reload ↻** on the `ZeroG Code — Gemini Web Bridge` card.)*
4. Open `https://gemini.google.com` in Chrome and make sure you are signed in.

---

## Step 3: End-to-End Verification

Run this check after the user loads the Chrome extension (and completes `agy` sign-in if exit code was `3`):

```powershell
# 1. Verify VS Code extension installed cleanly
code --list-extensions --show-versions | Select-String "zerog-code|ccweb|antigravity-tabs"

# 2. Verify Web Bridge + Chrome Extension live handshake
Invoke-RestMethod http://127.0.0.1:18765/status | Select-Object ok, browserOnline, cwd, version
```

Expected healthy result:
- `code --list-extensions --show-versions` shows `orinplin99-maker.zerog-code@0.7.8` (and no legacy `orinpl.ccweb-for-antigravity` or `local.antigravity-tabs`).
- `http://127.0.0.1:18765/status` returns `ok: True` and `browserOnline: True`.

Finally, instruct the user:
1. In VS Code / Cursor press `Ctrl+Shift+P` → **`Developer: Reload Window`**.
2. Press `Ctrl+Shift+Alt+N` (or click **`ZeroG`** in the bottom status bar) to open a tab.
3. Optional quick smoke test:
   - CLI channel: send a message or run `/usage`
   - Web channel: run `/web` (or pick `🌐 Web · 4 Neon` / `4 Carbon` / `4 Hydrogen` in `/model`) and verify it replies + runs local tools seamlessly.

---

## Repackaging Artifacts (Maintainers)

```powershell
./scripts/build_vsix.ps1        # Outputs dist/zerog-code-<ver>.vsix
./scripts/build_chrome_ext.ps1  # Outputs dist/zerog-code-chrome-extension-<ver>.zip
```

---

## Common Troubleshooting

- **Chrome extension shows `browserOnline: False`**: Confirm `chrome://extensions/` has **ZeroG Code — Gemini Web Bridge** enabled with no Service Worker errors, click **Reload ↻** on the extension card, and refresh any open `gemini.google.com` tab.
- **Port `18765` stuck / stale Node process**: Run `& "$env:USERPROFILE\.gemini\web-bridge\stop-bridge.ps1"` followed by `& "$env:USERPROFILE\.gemini\web-bridge\start-bridge.ps1"`.
- **Want custom project-specific shortcuts in Gemini Web**: Place a `LOCAL_TOOL_INDEX.md` inside `%USERPROFILE%\.gemini\web-bridge\`; `server.mjs` injects it automatically on the first Web turn (replacing `${WORKSPACE}` with the active workspace path).
