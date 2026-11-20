# Changelog

## 0.7.7
- **Compact Context & Switch to Fresh Web Window (`/compact`, `/compact-web`)**:
  - Added one-click context compaction (`src/webHistoryStore.js`, `src/chatPanel.js`, `media/chat.js`) to summarize long conversations within a strict character budget, preserve all local history turns, open a fresh Gemini Web chat window with clean handoff context, archive previous `webChatUrl` links, and render live `compact_divider` cards.
  - Added `agyTabs.memoryDir` setting (`src/configPaths.js`, `src/webBrainClient.js`) and `WEB_BRIDGE_MEMORY_DIR` env forwarding for explicit memory directory configuration.
- **On-Demand Lightweight Context (`get_context`) & Resilient Web Tool Execution (`v2.6.7` Chrome Extension + Web Bridge)**:
  - Slimmed first-turn Web collaboration protocol (`web-bridge/server.mjs`, `web-bridge/chrome-extension/content.js`) and introduced on-demand `get_context` (`rules`, `memory`, `skills`, `index`, `all`) with normalized `~/` paths, lightweight rule/memory indexing, and automatic rule-doc neutralization.
  - Added fair-share batch output budgeting with exact `startLine` continuation hints, partial read-only tool rescue on truncated streams, and lightweight auto-recovery for mid-conversation interruptions.

## 0.7.6
- **Resilient Web Error Auto-Retry (`v2.6.6` Chrome Extension + Web Bridge)**:
  - Added `TRANSIENT_ERROR_REPLY_RE` / `isTransientErrorReply` across `web-bridge/server.mjs` and `web-bridge/chrome-extension/content.js` to automatically catch transient Gemini Web error replies (e.g. `I encountered an error doing what you asked. Could you try again?`, `Something went wrong`, `There was an error generating a response`, Chinese equivalents, and blank replies) and retry up to 2 times with exponential backoff (2.5s / 4.5s) instead of terminating the turn; also rescues valid streamed tool blocks/long replies if replaced by an error message, and folds retry prompts cleanly during `/pull`.
  - Increased watchdog & browser-reported retryable step attempts from 1 to 2 with backoff (`nextDispatchAt`), and expanded `PAGE_ERROR_RE` toast detection.
- **User Manual Browser Window Isolation & Tab Stability (`v2.6.5`–`v2.6.6`)**:
  - Hard-isolated bridge-managed Gemini tabs (`isManagedTab` / `isBridgeOwnedTab`) from user-opened Chrome windows: new chats, continuations, `/pull`, `set_model`, `list_conversations`, and auto-close strictly reuse/close only idle bridge-owned tabs without hijacking or closing manual tabs.
  - Preserved user focus when working in a non-managed Gemini tab (background `WEB_TICK` parsing without focus stealing), added real-time tab liveness probes, serialized command routing (`commandChain` + `reservedTabIds`), fixed reverse-map cleanup in `bindSessionToTab`, and added idempotent content-script injection guards.
- **Web History `/pull` Merge, Compact Code Links & One-Click Bridge Restart**:
  - Added `ZeroG: Restart Local Web Bridge` command (`agyTabs.restartWebBridge`), `/restart-bridge` slash command, and sync popover action.
  - Improved `/pull` reverse-anchor turn alignment & missing-reply backfilling (`src/webHistoryStore.js`, `src/chatPanel.js`, `web-bridge/server.mjs`), switched Web protocol citations to backtick `path:line` links (avoiding Gemini Web rewriting relative Markdown links), and formatted code-location link labels cleanly as `FileName:Line`.

## 0.7.5
- **Explicit Configurable Paths (No Implicit Path Exploration) & Auto-Install `agy` CLI in Deploy Skill**:
  - Added centralized `src/configPaths.js` and explicit VS Code settings (`agyTabs.webBridgeScript`, `agyTabs.agyDataDir`, `agyTabs.mcpConfigPath`, `agyTabs.workspaceMcpPaths`, `agyTabs.skillDirs`, `agyTabs.rulesDir`, `agyTabs.extraSearchRoots`), eliminating implicit parent-directory climbing in `_resolveOpenTargetPath` (now opt-in via `agyTabs.extraSearchRoots`) and eliminating editor-extension directory scanning in `web-bridge/server.mjs` (replaced with explicit `WEB_BRIDGE_*` env vars, bundled `mcpManager.js`, and optional `bridge.config.json`).
  - Upgraded `skills/zerog-code-deploy/scripts/deploy.ps1` and `SKILL.md`: automatically installs Antigravity CLI (`agy`) via the official installer by default whenever missing (opt out with `-NoInstallAgy`), bundles shared MCP helpers into `~/.gemini/web-bridge/`, deploys all components before checking `agy` sign-in so new machines only need interactive browser login once, and updated `DEPLOY.md` & `readme.md`.

## 0.7.4
- **General-Purpose & Cross-Platform Refactoring**:
  - Removed developer-specific `~/.gemini/config/skills/agy-tabs-setup/...` lookup in `web-bridge/server.mjs` in favor of dynamic `mcpManager.js` resolution across `web-bridge/`, `../src/`, and installed VS Code / Cursor `orinplin99-maker.zerog-code-*` extensions.
  - Made `web-bridge/server.mjs` `run_command` cross-platform (`pwsh`/`powershell.exe` on Windows, `$SHELL`/`/bin/bash`/`/bin/sh` on macOS & Linux), added `$HOME` expansion in `resolveSafePath`, and added `~/.local/bin` & `~/.antigravity/bin` to `resolveAgyExecutable`.
  - Expanded directory skip lists across `src/chatPanel.js` (`@` search) and `web-bridge/server.mjs` (`find_files` / `nodeSearch`) to cover mainstream ecosystems (`dist`, `build`, `out`, `target`, `.next`, `.nuxt`, `.cache`, `coverage`, `__pycache__`, `.venv`, `venv`, `.gradle`, `Library`, `Temp`, `Obj`, etc.), merged VS Code `files.exclude` / `search.exclude` + new `agyTabs.searchExclude` setting & `WEB_BRIDGE_SKIP_DIRS` env var, added truncation notice to `list_dir`, fixed Windows drive-case relative paths in `find_files`, and prioritized open workspace roots before bounded parent fallback in `_resolveOpenTargetPath`.
  - Unified Skill discovery across `src/webBrainClient.js` and `web-bridge/server.mjs` (workspace `.agent/skills`, `.claude/skills`, `.gemini/skills` + global `~/.gemini/config/skills`, `~/.claude/skills`).
  - Changed `agyTabs.defaultModel` / `agyTabs.defaultEffort` defaults to `""` (follow `agy` CLI defaults instead of forcing legacy `gemini-4-argon`), made `/cli` pick the first available CLI model dynamically, added `agyTabs.webBridgePort` setting (default `18765`), and added a clear compatibility error in `src/sessionFork.js` when built-in `node:sqlite` is unavailable.
- **Sticky Pinned Current-Turn Prompt Bar & More Prominent User Prompt Cards**:
  - Added `#pinnedPromptBar` (`src/chatPanel.js`, `media/chat.js`, `media/chat.css`): when scrolling down past a turn's `.user-card`, the current turn's prompt (with `提问` badge, compact clickable file chips, image count tag, and up to 2 lines of prompt text) automatically pins below the topbar, smoothly pushes aside when transitioning to the next turn, and scrolls back to the full prompt card when clicked.
  - Enhanced `.user-card` visual contrast with an accent-tinted elevated surface, stronger border, 3.5px left `--accent` bar, subtle shadow, brighter file chips, and medium-weight 13.5px prompt typography.

## 0.7.3
- **Fix `Session not found` After Browsing Past Conversations Across Tabs & Add Silent ACP Self-Healing**:
  - Added reference-counted shared ACP session release (`_releaseAcpSession` in `src/chatPanel.js`, owner-checked `unregisterSession` & rollback on failed `loadSession` in `src/acpClient.js`): switching or closing a tab that previously loaded a session still open in another tab no longer calls `session/close` on the shared `agy acp` server and hands callback ownership back to the remaining tab.
  - Added automatic silent recovery (`_callAcpWithRecovery` / `_recoverAcpSession`) for `session/prompt`, `session/set_config_option`, and `session/set_mode`: if ACP reports `Session not found` (e.g. after MCP restart, ACP crash, or session eviction), the tab silently reloads the session without duplicating history in the webview, reapplies current model/thinking/mode settings, and retries once (or creates a fresh backing session for empty/web-only tabs with no `.db` on disk).
  - Separated logical `sessionId` from backing `acpSessionId` so pure-WebBrain history sessions that fall back to `newSession` switch cleanly to `/cli`, and serialized prompts/config changes behind in-flight `_sessionLoadPromise` to prevent history-load races.

## 0.7.2
- **Filter Out Non-Model `自动` / `Auto` Entry from Web Model Picker**:
  - Excluded the `自动` (`Auto`) router item from both `DEFAULT_WEB_SUBMODELS` and dynamically synced Gemini Web model options (`src/webBrainClient.js`), leaving only the 3 concrete Gemini Web models (`4 Neon`, `4 Carbon`, `4 Hydrogen`) and aligning the synced count notice in `src/chatPanel.js`.

## 0.7.1
- **Dynamic Gemini Web Model Sync & `4 Neon` Support**:
  - Updated `injectWebBrainModelOption` (`src/webBrainClient.js`) to dynamically render the live models discovered from `gemini.google.com` (`webModelState.availableOptions`) instead of a hardcoded list, extracting canonical model names (e.g. `4 Neon`, `4 Carbon`, `4 Hydrogen`, `自动`) from Gemini Web's updated two-line menu (`Deeper analysis / 4 Neon · 新`, `Code & complex work / 4 Carbon`, `日常帮助 / 4 Hydrogen`) so model switching and current-label detection match accurately.
  - Wired `syncWebModels` in `src/chatPanel.js` (`_handleSyncWebModels`) to call Web Bridge `/web-brain/models/sync`, refresh all open ZeroG tabs, and send `webModelsSynced` back to the `🌐 ⟳` button in the `/model` popover; also hydrated `webModelState` on session startup via `/status`.
  - Updated fallback defaults and `/web` toggle (`media/chat.js`, `src/webBrainClient.js`, `src/webHistoryStore.js`) from legacy `web:4 Argon` to dynamically pick the first concrete Web model (falling back to `web:4 Neon`), and added `Neon` recognition when importing conversations via `/pull`.

## 0.7.0
- **Rebranded to ZeroG Code** (`orinplin99-maker.zerog-code`):
  - Updated extension display name, command palette category (`ZeroG`), status bar label (`ZeroG`), welcome screen branding, output channel, and repository URLs to `https://github.com/orinplin99-maker/ZeroG-Code`.
  - Designed a brand-new **ZeroG Code** icon (`media/icon.png` + `media/icon.svg`) featuring a floating terminal prompt (`>_`) encircled by a zero-gravity cyan-to-violet orbital arc and dual-channel spark node.
  - Updated `scripts/setup.ps1` to automatically clean up the previous `orinpl.ccweb-for-antigravity` extension ID on upgrade while keeping existing `agyTabs.*` settings and keybindings intact.
  - Committed `src/mcpManager.js`, `src/mcpHttpBridge.js`, and MCP popover styles (`media/chat.css`) into the repository and stopped tracking legacy `.vsix` binaries under `dist/`.

## 0.6.3
- **Per-Session Isolated Cancel (No Longer Stops Other Running Web Sessions)**:
  - `cancelWebBrainTurn` (`webBrainClient.js`), `chatPanel.js` (`cancelPrompt` / `_startFreshConversation` / `_switchToSession` / `dispose`), and `/web-brain/cancel` (`server.mjs`) now strictly scope cancellation to the specific `requestId` / `sessionId` instead of broadcasting an empty `{}` cancel that terminated every active and queued Web session across all tabs.
  - Browser `cancel` commands now carry `sessionId` and `webChatUrl`, are skipped if the task was still `queued` or running local tools, and `background.js` / `content.js` (`v2.6.1`) verify the bound tab and `activeWatchState.reqId` instead of falling back to clicking Stop on another session's active tab.
- **True Serialized Sending (`串行发送`) + Multi-Tab Parallel Generation Without Queue Deadlocks**:
  - Replaced the global whole-generation queue lock (`generatingTask`) in `server.mjs` with a short **Send-phase handshake lock** (~1.5–2s until `content.js` reports `status: 'sent'`, capped at 10s) plus per-session step serialization: multiple chat tabs now send one after another within seconds instead of staying stuck in `⏳ 排队中` for minutes while another tab thinks or runs ReAct steps.
  - Fixed `background.js` (`v2.6.1`) `closeOtherSessionTabs` and tab-reuse logic so active/queued/tool-running sessions' Chrome tabs are never closed or hijacked by another session, added 2.2s round-robin tab activation across concurrent generating Gemini tabs so background tabs never stall on `requestAnimationFrame` throttling, and added fast-fail notification if a bound tab is manually closed.

## 0.6.2
- **Response Formatting Specification & Clickable Code Location Blue Links**:
  - Added mandatory response formatting rules in Web Bridge (`server.mjs`, `content.js`, `webBrainClient.js`) instructing Gemini Web to cite all files and line ranges as clickable Markdown blue links (`[FileName:Line](rel/path#Lline)` / `[FileName:Start-End](rel/path#Lstart-Lend)`).
  - Upgraded `chat.js` Markdown renderer to render `[label](path#Lline)` links, standalone inline code file/line tokens (`` `path/to/file.ts:42-58` ``, `` `file.ts:42` ``), bare `path/file.ext:line` spans, and Cursor-style code block headers (`42:58:src/app.ts`) as clickable blue links, while hiding raw `json:local-tool` protocol JSON blocks from prose.
  - Upgraded `chatPanel.js` `_handleOpenFile` + `normalizeFsPath` to support `:start-end` / `#Lstart-Lend` ranges, `~/` paths, ancestor project-root resolution (e.g. parent `Source/...` from a subdirectory workspace), workspace filename fallback lookup, binary file `vscode.open`, and centered line-range reveal.
  - Upgraded `content.js` `domToMarkdown` to preserve `<a href>`, `<strong>`, `<em>`, `<blockquote>`, and GFM `<table>` markup during streaming and history scraping.
- **Bidirectional Web ↔ Local Sync (`/sync` push & `/pull` web history import + seamless continuation)**:
  - Upgraded topbar Sync button into a bidirectional sync popover (`#syncPopover`) and added `/pull [url]` + `/sync pull` + `🌐 网页拉取` in `/resume`: browse live recent conversations directly from `gemini.google.com` sidebar (or paste any `gemini.google.com/app/<id>` URL), pull full multi-turn history into CCWeb (automatically stripping protocol headers & merging ReAct steps), and seamlessly continue that exact web conversation on either `🌐 Gemini Web` or local `/cli`.
  - Fixed `readCliTranscriptTurns` & `updateWebHistorySyncMeta` so interrupted/unanswered local turns are no longer skipped by `/sync`, and synced `webChatUrl` bindings survive window reloads.
- **Zero-Clutter Automatic Web Window Lifecycle (Chrome extension `v2.6.0` + `agyTabs.autoCloseWebTab`)**:
  - Automatically closes the managed Gemini Web tab after a turn/sync/pull completes and whenever closing a VS Code tab, starting `/new`, switching `/resume` sessions, or switching back to `/cli` (safely creating a blank `chrome://newtab/` first if it is the last browser tab so Chrome never exits, and evicting idle session tabs so multiple Gemini windows never pile up).
  - Continuing any conversation automatically reopens its bound `https://gemini.google.com/app/<chatId>` historical chat URL; added `chrome.alarms` + periodic MV3 Service Worker keepalive so the bridge stays online even with zero open Gemini tabs.

## 0.6.1
- **Uncap 🌐 Gemini Web tool steps & batch limits**: removed the local 8/12/16 step cap (`maxSteps: 0` unlimited by default) and the 5-tool-per-batch truncation (`executeBatch` now runs the full tool array with per-tool output caps and 48,000-char batch budget, `read_file` up to 1,200 lines, `search_code` up to 80 hits / 16,000 chars, `run_command` 16,000 chars, `mcp_call` 20,000 chars).
- **Prevent mid-task interruptions & false tool-limit stops**:
  - Updated Web Bridge protocol & follow-up reminders to explicitly forbid invoking Gemini Web's built-in cloud Python/Search sandbox on local paths (avoiding cloud `0 remaining` confusion), added `~` / `%USERPROFILE%` path expansion, lenient JSON tool-block parsing (trailing commas / unescaped Windows backslashes), and automatic new-turn continuation if the model mistakenly claims a tool limit.
  - Sanitized sensitive API keys/tokens in tool results before sending back to Gemini Web, and added mid-stream rescue (`bestText` / `bestStepText`) + automatic de-sensitized retry when Gemini Web's post-stream safety filter replaces a valid tool block or reply with a canned refusal.
  - Deduplicated unchanged active-editor file attachments across turns in the same Web session (`webBrainClient.js`), and hardened `stop-bridge.ps1` to stop orphaned Node processes listening on port `18765`.

## 0.6.0
- **One-click context sync to 🌐 Gemini Web** (topbar cloud-upload button or `/sync`): sends this conversation's not-yet-synced CLI turns (up to the last 30 turns, larger per-turn limits than the automatic switch sync) to the tab's bound Gemini Web conversation and asks it to confirm with a short summary. The selected model stays unchanged, the sync turn is not saved as a Web turn, and later switching to a Web model will not re-send the same turns.

## 0.5.9
- **Long thinking / slow tools no longer cut off** (Chrome extension `v2.5.1`): once the message appears in the Gemini conversation it is treated as sent, and the page keeps sending 15s heartbeats while thinking (up to 15 minutes) instead of failing after 60s; the 60s error now only fires when the message never got sent. `run_command` default timeout 45s → 180s (max 600s), `mcp_call` 25s → 180s, `search_code` 15s → 60s. Errors reported by a stale (not refreshed) content script now tell you to refresh the extension and Gemini tabs.
- **🌐 Gemini Web reliability (stuck turns, replies not returned, investigations stopping half-way)**:
  - Web Bridge now runs only one web generation at a time across all chat tabs (dispatching activates the bound Chrome tab, so concurrent tabs starved each other and their replies never came back); queued tabs show "⏳ 排队中" in the thinking block.
  - Reports are tagged with the step number; late/duplicate/stale reports are dropped instead of overwriting the current step. Browser acknowledges each command (re-dispatched once after 45s without ack), sends a heartbeat every 15s during long thinking, and a watchdog turns a silent task into a clear error after 5 minutes instead of spinning forever.
  - Local tools run in the background after the browser's completion report is answered immediately; completion reports retry up to 4 times; clipboard reads/writes have timeouts so a permission prompt can no longer block the completion report.
  - Completion waits for unclosed code fences to close; the tool-call parser also accepts unclosed fences, any fence language and unfenced trailing tool arrays.
  - Default tool budget raised to 12 steps per user message; the last step is forced to give a final/partial answer (listing what is left) instead of ending on an unexecuted tool block.

## 0.5.8
- **🌐 Gemini Web parity with local CLI (images, `/skills`, MCP tools, active investigation)**:
  - Forward pasted/attached VS Code screenshots (`images`) to Gemini Web (Chrome extension `v2.4.0` attaches via `paste` / `file input` / `drop`) and persist/replay them in `webHistoryStore.js` & `chat.js`.
  - Automatically detect `/skill-name` (e.g. `/code-review`) and inject `SKILL.md` + `scripts/` directory hints instead of letting Web Brain fail searching only the workspace directory.
  - Added `find_files`, `mcp_list`, and `mcp_call` tools to `LocalToolExecutor`, exposed `~/.gemini/config/skills`, `~/.gemini/config/rules`, and configured MCP servers in `buildSystemToolProtocol`, raised default ReAct cap to 8 steps, and injected a concise per-turn reset reminder so Turn 2+ proactively invokes local tools instead of hallucinating a tool limit.
  - Prevented `detectUsageLimitNotice` from mistaking assistant prose like "工具调用上限" for a Google quota warning.

## 0.5.7
- Fixed garbled 🌐 Gemini Web replies while streaming (e.g. a `json:local-tool` block split into broken code blocks / text with missing characters): web page text is not append-only (code blocks form mid-stream, and the final text is swapped for the raw Markdown from Gemini's Copy button), but deltas were appended by length. Now text is appended only when it extends what was rendered; otherwise the current reply block is replaced (`agent_message_replace`). Thoughts are only appended on prefix match.
- Web Bridge ignores usage reports from stale content scripts left in already-open tabs after the extension is reloaded (extension `v2.3.2`).

## 0.5.6
- Fixed Gemini Web limits: the usage page has no real `role=progressbar` (the matched one was the sidebar loading spinner), so the extension (`v2.3.1`) now parses the 「当前用量 / Current usage」(5-hour) and 「每周限额 / Weekly limit」 sections from page text, including used % and reset time, and shows the plan tier (e.g. `Gemini ULTRA`).
- Fixed intermittent web-turn errors: Web Bridge local tools (`search_code` / `run_command`) used `execSync` and blocked the bridge event loop for up to 15–45s, so VS Code polls timed out (`Request timeout`). Tools now run asynchronously, and the poll loop silently retries transient failures for up to 30s. The "web page not started" timeout was raised from 25s to 60s for long thinking.

## 0.5.5
- **🌐 Gemini Web 5-hour / Weekly limit progress bars in `/usage`**: the Chrome extension (`v2.3.0`) reads the real progress bars from `gemini.google.com/usage` (Settings → Usage limits) by DOM only, in a background tab that closes itself after reading (refresh throttled to once per 60s, re-read when cached data is older than 3 minutes or on ⟳). Local per-bridge message counts are kept as a compact secondary line.

## 0.5.4
- **🌐 Gemini Web usage in the `/usage` panel**: shows messages and input/output characters sent through the Web Bridge for the last 5 hours / today / last 7 days (per web model), plus any usage-limit notice detected on `gemini.google.com`. gemini.google.com has no public quota API, so these numbers are local bookkeeping (`~/.gemini/web-bridge/web_usage.json`).
- Chrome extension `v2.2.0`: long prompts are filled through a single `paste` event (fast for very large contexts), and replies are taken from Gemini's own **Copy** button as raw Markdown (tables/formulas preserved). The user's clipboard is read first and restored right after, and the DOM parser is used as fallback.

## 0.5.3
- **Account-Safe Pure ISOLATED DOM Mode & Persistent 1:1 `sessionId <-> Browser Tab` Continuous Chat**:
  - Removed `world: "MAIN"` `XHR/fetch` monkey-patching (`page-hook.js`) and `declarativeNetRequest` packet header rewriting to avoid Google account anti-automation risk, adding humanized random delays (`420~940ms` send jitter, `1.8~3.8s` ReAct step interval) and capping ReAct steps (`maxSteps = 5`).
  - Persisted `sessionId -> tabId` bindings in `chrome.storage.local` (`background.js` `v2.1.2`) and fixed `webBrainClient.js` so all messages inside the same VS Code chat tab stay continuously in the same Gemini Web conversation tab without opening new tabs, only switching/opening a new Gemini Web tab when opening a new VS Code chat tab (new `sessionId`).

## 0.5.2
- **Service Worker Pure HTTP `StreamGenerate` Engine + Network-Layer XHR Stream Interception (Zero Tab-Switch Loss)**:
  - Moved the primary `StreamGenerate` HTTP streaming client directly into the Chrome Extension Service Worker (`background.js` + `declarativeNetRequest` Origin/Referer header rule), eliminating DOM `requestAnimationFrame` freezing when switching Chrome tabs or minimizing the browser.
  - Upgraded `page-hook.js` (`world: "MAIN"`) to intercept `XMLHttpRequest` `progress`/`load` network streams directly instead of scraping DOM nodes, and disabled webpage `autoLoop` by default so the webpage widget never hijacks multi-step ReAct tool calls from VS Code.
  - Added per-`sessionId` `webChatUrl` + `webCursor` routing and full `transcript.jsonl` CLI context sync when switching to Web models mid-conversation.

## 0.5.1
- **Windowless In-Browser Direct HTTP (`StreamGenerate`) & Multi-Tab Independent Session Cursors (`[cId, rId, rcId]`)**:
  - Added `page-hook.js` (`world: "MAIN"`) to intercept and replay `gemini.google.com`'s internal `StreamGenerate` RPC directly via in-browser `fetch` (preserving real browser cookies, TLS fingerprint, and `x-goog-ext-*` model/thinking headers), with automatic DOM fallback to refresh templates when needed.
  - Bound each VS Code tab (`sessionId`) to its own persistent Gemini Web `[cId, rId, rcId]` conversation cursor in `webHistoryStore.js` and upgraded `server.mjs` to a concurrent `webTasks` map so multiple VS Code tabs maintain completely isolated conversations without switching or touching the browser UI window.
  - Fixed menu item visibility check (`getBoundingClientRect` instead of `offsetParent`) in `content.js` for `position: fixed` Angular Material model/effort menus.

## 0.5.0
- **1:1 Gemini Web Model & Thinking Level (`思考等级`) Alignment + Local History Persistence (`webHistoryStore.js`)**:
  - Aligned Web model options 1:1 with `gemini.google.com` (`🌐 Web · 4 Argon (代码与分析)`, `🌐 Web · 4 Carbon (高难任务)`, `🌐 Web · 4 Hydrogen (日常帮助)`, `🌐 Web · 3.5 Flash-Lite (快速解答)`).
  - Fixed two-level menu switching on `gemini.google.com` (first-level model selection + second-level `思考等级 ▸` submenu hover/click for `低 / 中 / 高`), and moved background polling into the Chrome Extension Service Worker (`background.js`) with IPC wakeup so switching models or streaming replies works with zero lag even when Chrome is covered by VS Code.
  - Added `webHistoryStore.js` to persist all Web Brain conversations (`userText`, `attachments`, `thoughts`, `tools`, `assistantText`, `webModelId`, `webEffort`) into `~/.gemini/antigravity-cli/web_history/<sessionId>.json` and `conversation_summaries.db`, so `/resume`, Welcome recent sessions, and `Developer: Reload Window` restore Web Brain conversations seamlessly.

## 0.4.9
- **Zero-Token Server-Side ReAct Loop (`json:local-tool`), Web Model & Effort Switching, Thoughts Streaming & MCP Server**:
  - Added support for selecting and switching browser `gemini.google.com` models (`🌐 Web · Argon`, `🌐 Web · Gemini Pro`, `🌐 Web · Gemini Flash`, plus dynamically discovered web menu options) and thinking effort (`/effort low|medium|high`) directly from the CCWeb model popover & slash commands.
  - Upgraded `server.mjs` with native zero-token `LocalToolExecutor` (`read_file`, `edit_file`, `write_file`, `search_code`, `list_dir`, `run_command`), batch `json:local-tool` array support, and multi-step server-side ReAct orchestration.
  - Synced Gemini Web's `model-thoughts` stream into CCWeb's `Thinking…` blocks, added automatic `newChat` reset on `/new`, and registered `mcp-server.mjs` (`gemini_web_ask`, `gemini_web_agent`).

## 0.4.8
- **Bidirectional Gemini Web Brain (`🌐 Gemini Web (外置大脑)`) & CLI Seamless Switching (`/web`, `/cli`)**:
  - Added `🌐 Gemini Web (外置大脑)` to the `/model` selector and added `/web` & `/cli` slash commands to switch seamlessly between browser `gemini.google.com` and local `agy` CLI models inside the same conversation tab, automatically syncing conversation context across switches.
  - Added `webBrainClient.js` for live streaming responses from `gemini.google.com` via the local Web Bridge (`127.0.0.1:18765`), with automatic multi-step local tool execution (`read_file`, `search_code`, `list_dir`, `edit_file`, `write_file`, `run_command`) and optional `agy acp` delegation.

## 0.4.7
- **Full MCP Support (`/mcp` panel, HTTP MCP protocol self-healing bridge, workspace `.mcp.json`)**:
  - Added `/mcp` command & topbar button to view all configured MCP servers (`stdio` & `http`, global & workspace), live connection status, and mounted tool schemas, with one-click **Enable / Disable**, **↻ Reconnect**, and **Config** editor shortcut.
  - Added `mcpHttpBridge.js` auto-healing bridge for Streamable HTTP MCP servers: fixes string JSON-RPC `id` responses, echoes `protocolVersion` during `initialize`, sends explicit `Content-Length` headers, and fails fast when a local editor/service is offline instead of stalling startup for 30s.
  - Automatically loads workspace `.mcp.json` / `.vscode/mcp.json` servers into ACP sessions and formats `call_mcp_tool` / `mcp_*` calls cleanly in the chat stream.

## 0.4.6
- Default model & thinking level set to **Gemini 4 Argon · High** (`agyTabs.defaultModel = "gemini-4-argon"`, `agyTabs.defaultEffort = "high"`), and re-applied automatically when restoring open tabs across VS Code restarts/reloads or resuming past conversations (`session/load` otherwise resets ACP options to Carbon/Medium/Default).

## 0.4.5
- ** ~20x faster past conversation loading & instant `/resume`**:
  - Switched `agy acp` from `--process-per-session` cold worker spawns (~2.7s per tab/load) to a pre-warmed shared multi-session ACP server (~18ms `session/new`, ~110ms `session/load`).
  - Added ~1ms SQLite fast-path (`conversation_summaries.db`) for `/resume` and Welcome recent sessions so history lists appear immediately.
  - Stripped unused multi-megabyte full-file snapshots (`content` / `rawOutput`) from `tool_call` updates (~70x smaller IPC payload), micro-batched history updates via `DocumentFragment`, deferred Markdown/thought rendering per block, lazily rendered collapsed `.tool-details` on expand, and fixed trailing history chunks being dropped after `session/load` resolves.
- **Added `/effort` command**: switch model thinking / effort level directly from the composer (`/effort`, `/effort low|medium|high|xhigh`, inline `/` autocomplete picker, and popover pills).

## 0.4.4
- Fixed `/resume` hiding recent conversations: agy is now spawned inside the workspace folder (it records its process cwd as the session workspace), and sessions recorded under the old extension-host cwd are still listed for the current workspace.

## 0.4.3
- Conversation Fork (Claude Code style): hover any user message (`⑂ Fork` / right-click `Fork conversation from here`) to branch prior context into a new tab with that message pre-filled in the composer; also added `/fork`, a topbar Fork button, a `Fork` button in `/resume` past sessions, and `CCWeb: Fork Conversation in New Tab`.

## 0.4.2
- Instant `/usage` panel: persist plan limits in VS Code `globalState`, pre-sync silently in the background on session start and after turns, and render cached quota immediately (stale-while-revalidate).

## 0.4.1
- Replaced extension icon with a new multi-tab editor + AI prompt (`>_`) badge generated via Nano Banana (256×256 transparent-corner PNG + matching tab bar SVG).

## 0.4.0
- Renamed to **CCWeb for Antigravity** (publisher `Orinpl`). It is an unofficial client for the Antigravity CLI.
- New icon.

## 0.3.0
- `/usage` panel: plan limits (5-hour and weekly) and this conversation's token totals.
- `/resume`: history grouped by date, with search and a history button in the top bar.
- Messages typed while the agent is working are queued and sent when the turn ends.
- Copy: per-message Copy button, right-click menu, and Ctrl+C on a selection.

## 0.2.x
- `/model` switches the model and thinking level. `Shift+Tab` cycles the permission mode only.
- Multi-tab chat over `agy acp`, editor context chips, `@` file mentions, permission cards, diffs.
