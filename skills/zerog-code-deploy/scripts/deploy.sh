#!/usr/bin/env bash
# macOS / Linux counterpart of deploy.ps1:
# Node.js check -> Antigravity CLI (agy) check & auto-install -> install prebuilt VSIX
# -> deploy & start local Web Bridge (~/.gemini/web-bridge) + Chrome MV3 extension
# -> register gemini-web-agent MCP -> verify agy sign-in & Chrome extension connection.
#
# Exit codes:
#   0 = ok, 1 = Node.js (>=18) missing, 2 = agy missing or auto-install failed,
#   3 = deployed but agy not signed in, 4 = VSIX not found, 5 = editor install failed,
#   6 = Web Bridge failed to start, 7 = repository not found.
set -uo pipefail

REPO_URL="https://github.com/orinplin99-maker/ZeroG-Code-release.git"
REPO_DIR=""
AUTO_CLONE=0
EDITOR="code"
NO_INSTALL_AGY=0
SKIP_AUTH_CHECK=0
SKIP_VSCODE=0
SKIP_WEB_BRIDGE=0
SKIP_MCP=0
INSTALL_SKILL=0
OPEN_CHROME_EXT=0

# macOS has no coreutils `timeout` by default.
run_with_timeout() {
  local secs="$1"
  shift
  if command -v timeout >/dev/null 2>&1; then timeout "$secs" "$@"; return $?; fi
  if command -v gtimeout >/dev/null 2>&1; then gtimeout "$secs" "$@"; return $?; fi
  "$@" &
  local child=$!
  ( sleep "$secs" && kill -9 "$child" 2>/dev/null ) &
  local watchdog=$!
  wait "$child"
  local rc=$?
  kill "$watchdog" 2>/dev/null || true
  return $rc
}

ok()   { printf '[OK]   %s\n' "$1"; }
info() { printf '[..]   %s\n' "$1"; }
warn() { printf '[WARN] %s\n' "$1"; }
fail() { printf '[FAIL] %s\n' "$1" >&2; exit "$2"; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo-dir) REPO_DIR="${2:-}"; shift 2 ;;
    --auto-clone) AUTO_CLONE=1; shift ;;
    --editor) EDITOR="${2:-}"; shift 2 ;;
    --no-install-agy) NO_INSTALL_AGY=1; shift ;;
    --skip-auth-check) SKIP_AUTH_CHECK=1; shift ;;
    --skip-vscode) SKIP_VSCODE=1; shift ;;
    --skip-web-bridge) SKIP_WEB_BRIDGE=1; shift ;;
    --skip-mcp) SKIP_MCP=1; shift ;;
    --install-skill) INSTALL_SKILL=1; shift ;;
    --open-chrome-ext) OPEN_CHROME_EXT=1; shift ;;
    -h|--help)
      sed -n '2,12p' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *) fail "Unknown argument: $1" 7 ;;
  esac
done

is_repo() {
  [ -n "${1:-}" ] && [ -f "$1/web-bridge/server.mjs" ] &&
    { [ -f "$1/release.json" ] || [ -f "$1/package.json" ] || ls "$1"/dist/zerog-code-*.vsix >/dev/null 2>&1; }
}

# ── 0. Locate repository root ───────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CANDIDATES="$REPO_DIR
$(cd "$SCRIPT_DIR/../../.." 2>/dev/null && pwd || true)
$PWD
$HOME/.gemini/zerog-code-release
$HOME/.gemini/zerog-code"

RESOLVED_REPO=""
while IFS= read -r candidate; do
  if is_repo "$candidate"; then
    RESOLVED_REPO="$(cd "$candidate" && pwd)"
    break
  fi
done <<EOF
$CANDIDATES
EOF

if [ -z "$RESOLVED_REPO" ]; then
  if [ "$AUTO_CLONE" = "1" ]; then
    command -v git >/dev/null 2>&1 || fail "git not found; clone $REPO_URL manually and pass --repo-dir <path>." 7
    CLONE_TARGET="${REPO_DIR:-$HOME/.gemini/zerog-code}"
    info "Cloning $REPO_URL into $CLONE_TARGET ..."
    git clone "$REPO_URL" "$CLONE_TARGET" || fail "git clone failed." 7
    is_repo "$CLONE_TARGET" || fail "Cloned repo missing expected files at $CLONE_TARGET" 7
    RESOLVED_REPO="$(cd "$CLONE_TARGET" && pwd)"
  else
    fail "ZeroG-Code repository not found. Pass --repo-dir <path> or re-run with --auto-clone to clone $REPO_URL." 7
  fi
fi
ok "repo: $RESOLVED_REPO"

# ── 1. Node.js >= 18 ────────────────────────────────────────
command -v node >/dev/null 2>&1 || fail "Node.js (>= 18) is required. Install via: brew install node" 1
NODE_MAJOR="$(node -v | sed 's/^v\([0-9]*\).*/\1/')"
[ "${NODE_MAJOR:-0}" -ge 18 ] 2>/dev/null || fail "Node.js $(node -v) is too old (need >= 18). Upgrade via: brew install node" 1
ok "node: $(node -v) ($(command -v node))"

# ── 2. Antigravity CLI (agy) ────────────────────────────────
find_agy() {
  if command -v agy >/dev/null 2>&1; then
    command -v agy
    return 0
  fi
  for candidate in "$HOME/.local/bin/agy" "$HOME/.antigravity/bin/agy" "/usr/local/bin/agy" "/opt/homebrew/bin/agy"; do
    [ -x "$candidate" ] && { echo "$candidate"; return 0; }
  done
  return 1
}

AGY="$(find_agy || true)"
if [ -z "$AGY" ]; then
  if [ "$NO_INSTALL_AGY" = "1" ]; then
    fail "agy CLI not found (--no-install-agy). Install manually: curl -fsSL https://antigravity.google/cli/install.sh | bash" 2
  fi
  info 'Antigravity CLI (agy) not found - auto-installing via official installer...'
  curl -fsSL https://antigravity.google/cli/install.sh | bash || fail "Auto-installing agy CLI failed. Install manually: curl -fsSL https://antigravity.google/cli/install.sh | bash" 2
  export PATH="$HOME/.local/bin:$PATH"
  AGY="$(find_agy || true)"
  [ -n "$AGY" ] || fail 'agy CLI still not found after install (open a new terminal and retry, or check PATH).' 2
  ok "agy CLI auto-installed: $AGY"
else
  ok "agy: $AGY"
fi

# ── 3. Install ZeroG Code VS Code / Cursor extension ────────
VSIX_PATH=""
EXT_ID=""
EXT_VERSION=""
if [ "$SKIP_VSCODE" != "1" ]; then
  VSIX_RAW="$(node -e '
const fs=require("fs"),p=require("path");
const repo=process.argv[1];
const tryJson=(f)=>{try{return JSON.parse(fs.readFileSync(f,"utf8"))}catch{return null}};
const rel=tryJson(p.join(repo,"release.json"));
const pkg=tryJson(p.join(repo,"package.json"));
if(pkg&&pkg.version&&pkg.publisher&&pkg.name){
  const f=p.join(repo,"dist",`${pkg.name}-${pkg.version}.vsix`);
  if(fs.existsSync(f)){console.log([f,`${pkg.publisher}.${pkg.name}`,pkg.version].join("\t"));process.exit(0)}
}
if(rel&&rel.vsix){
  const f=p.isAbsolute(rel.vsix)?rel.vsix:p.join(repo,rel.vsix);
  if(fs.existsSync(f)){console.log([f,`${rel.publisher}.${rel.name}`,rel.version].join("\t"));process.exit(0)}
}
const dist=p.join(repo,"dist");
if(fs.existsSync(dist)){
  const hit=fs.readdirSync(dist).filter(n=>/^zerog-code-.*\.vsix$/.test(n)).sort().pop();
  if(hit){console.log(p.join(dist,hit)+"\t\t")}
}
' "$RESOLVED_REPO")"
  [ -n "$VSIX_RAW" ] || fail "No prebuilt VSIX found under $RESOLVED_REPO/dist" 4
  VSIX_PATH="$(printf '%s' "$VSIX_RAW" | cut -f1)"
  EXT_ID="$(printf '%s' "$VSIX_RAW" | cut -f2)"
  EXT_VERSION="$(printf '%s' "$VSIX_RAW" | cut -f3)"
  [ -f "$VSIX_PATH" ] || fail "VSIX output not found: $VSIX_PATH" 4
  ok "vsix: $VSIX_PATH"

  find_editor_cli() {
    case "$1" in
      code)
        command -v code 2>/dev/null && return 0
        for c in "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" "$HOME/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"; do
          [ -x "$c" ] && { echo "$c"; return 0; }
        done
        ;;
      cursor)
        command -v cursor 2>/dev/null && return 0
        for c in "/Applications/Cursor.app/Contents/Resources/app/bin/cursor" "$HOME/Applications/Cursor.app/Contents/Resources/app/bin/cursor"; do
          [ -x "$c" ] && { echo "$c"; return 0; }
        done
        ;;
      *) command -v "$1" 2>/dev/null && return 0 ;;
    esac
    return 1
  }

  INSTALLED_ANY=0
  INSTALL_FAILED=0
  for editor in $(printf '%s' "$EDITOR" | tr ',' ' '); do
    [ -n "$editor" ] || continue
    CLI="$(find_editor_cli "$editor" || true)"
    if [ -z "$CLI" ]; then
      warn "Editor CLI '$editor' not found - skipping"
      continue
    fi
    INSTALLED_ANY=1

    if [ -n "$EXT_ID" ]; then
      for legacy in local.antigravity-tabs orinpl.ccweb-for-antigravity; do
        if "$CLI" --list-extensions 2>/dev/null | grep -qx "$legacy"; then
          info "Removing legacy extension $legacy"
          "$CLI" --uninstall-extension "$legacy" >/dev/null 2>&1 || true
        fi
      done
    fi

    info "Installing ${EXT_ID:-$VSIX_PATH} into $editor ..."
    "$CLI" --install-extension "$VSIX_PATH" --force || true
    LISTED="$("$CLI" --list-extensions --show-versions 2>/dev/null || true)"
    if [ -n "$EXT_ID" ] && printf '%s\n' "$LISTED" | grep -qx "$EXT_ID@$EXT_VERSION"; then
      ok "$editor: $EXT_ID@$EXT_VERSION"
    elif [ -z "$EXT_ID" ] && [ -n "$LISTED" ]; then
      ok "$editor: extension installed"
    else
      printf '[FAIL] %s: expected %s@%s, got:\n%s\n' "$editor" "$EXT_ID" "$EXT_VERSION" "$LISTED" >&2
      INSTALL_FAILED=1
    fi
  done

  if [ "$INSTALLED_ANY" = "0" ]; then
    fail "No requested editor CLI ($EDITOR) found. Install manually: code --install-extension \"$VSIX_PATH\" --force" 5
  fi
  [ "$INSTALL_FAILED" = "0" ] || exit 5
fi

# ── 4. Deploy & start local Web Bridge + Chrome extension ───
BRIDGE_DST="$HOME/.gemini/web-bridge"
CHROME_EXT_DST="$BRIDGE_DST/chrome-extension"
BRIDGE_ONLINE=0

if [ "$SKIP_WEB_BRIDGE" != "1" ]; then
  BRIDGE_SRC="$RESOLVED_REPO/web-bridge"
  [ -f "$BRIDGE_SRC/server.mjs" ] || fail "Missing web-bridge/server.mjs in $RESOLVED_REPO" 6

  mkdir -p "$CHROME_EXT_DST"

  if [ -x "$BRIDGE_DST/stop-bridge.sh" ]; then
    info 'Stopping existing Web Bridge before updating files...'
    "$BRIDGE_DST/stop-bridge.sh" || true
  fi

  info "Deploying Web Bridge & Chrome Extension to $BRIDGE_DST (preserving user state/config)..."
  for f in server.mjs mcp-server.mjs start-bridge.sh stop-bridge.sh README.md CHATBOT_HARNESS_DESIGN.md; do
    [ -f "$BRIDGE_SRC/$f" ] && cp -f "$BRIDGE_SRC/$f" "$BRIDGE_DST/$f"
  done
  if [ -d "$BRIDGE_SRC/harness" ]; then
    mkdir -p "$BRIDGE_DST/harness"
    cp -f "$BRIDGE_SRC/harness/"* "$BRIDGE_DST/harness/" 2>/dev/null || true
  fi
  # 共享 MCP 帮助模块在发布仓里随 web-bridge/ 分发，在源码仓里位于 src/
  for helper in configPaths.js mcpManager.js mcpHttpBridge.js; do
    helper_src="$BRIDGE_SRC/$helper"
    [ -f "$helper_src" ] || helper_src="$RESOLVED_REPO/src/$helper"
    [ -f "$helper_src" ] && cp -f "$helper_src" "$BRIDGE_DST/$helper"
  done
  chmod +x "$BRIDGE_DST/start-bridge.sh" "$BRIDGE_DST/stop-bridge.sh" 2>/dev/null || true

  if [ -f "$BRIDGE_SRC/chrome-extension/manifest.json" ]; then
    cp -f "$BRIDGE_SRC/chrome-extension/"* "$CHROME_EXT_DST/" 2>/dev/null || true
  else
    CHROME_ZIP="$(ls -t "$RESOLVED_REPO"/dist/zerog-code-chrome-extension-*.zip 2>/dev/null | head -n 1)"
    [ -n "$CHROME_ZIP" ] || fail "Missing Chrome extension files under $BRIDGE_SRC/chrome-extension or dist/*.zip" 6
    info "Extracting prebuilt Chrome extension archive: $CHROME_ZIP"
    (cd "$CHROME_EXT_DST" && unzip -o -q "$CHROME_ZIP")
  fi
  ok "web-bridge & chrome-extension files deployed to $BRIDGE_DST"

  info 'Starting local Web Bridge daemon (127.0.0.1:18765)...'
  "$BRIDGE_DST/start-bridge.sh" --cwd "$PWD" || true

  for _ in 1 2 3 4 5 6; do
    if curl -fsS --max-time 2 "http://127.0.0.1:18765/status" >/dev/null 2>&1; then
      BRIDGE_ONLINE=1
      break
    fi
    sleep 0.6
  done
  [ "$BRIDGE_ONLINE" = "1" ] || fail "Web Bridge did not respond on http://127.0.0.1:18765/status. Check $BRIDGE_DST/bridge.log" 6
  ok "web-bridge online: http://127.0.0.1:18765"
fi

# ── 5. Register gemini-web-agent MCP server ─────────────────
if [ "$SKIP_MCP" != "1" ] && [ "$SKIP_WEB_BRIDGE" != "1" ]; then
  MCP_CFG="$HOME/.gemini/config/mcp_config.json"
  mkdir -p "$(dirname "$MCP_CFG")"
  node -e '
const fs=require("fs");
const [cfg,server]=process.argv.slice(1);
let json={};
try{json=JSON.parse(fs.readFileSync(cfg,"utf8"))||{}}catch{json={}}
if(!json.mcpServers||typeof json.mcpServers!=="object")json.mcpServers={};
json.mcpServers["gemini-web-agent"]={command:"node",args:[server],env:{WEB_BRIDGE_PORT:"18765"}};
fs.writeFileSync(cfg,JSON.stringify(json,null,2));
' "$MCP_CFG" "$BRIDGE_DST/mcp-server.mjs" || fail "Failed to register MCP server in $MCP_CFG" 6
  ok "MCP server registered: gemini-web-agent -> $MCP_CFG"
fi

# ── 6. Optional: install zerog-code-deploy Skill ────────────
if [ "$INSTALL_SKILL" = "1" ]; then
  SRC_SKILL="$RESOLVED_REPO/skills/zerog-code-deploy"
  if [ -d "$SRC_SKILL" ]; then
    TARGETS="$HOME/.gemini/config/skills/zerog-code-deploy"
    [ -d "$HOME/.claude" ] && TARGETS="$TARGETS
$HOME/.claude/skills/zerog-code-deploy"
    while IFS= read -r dst; do
      [ -n "$dst" ] || continue
      mkdir -p "$dst"
      cp -R "$SRC_SKILL/." "$dst/"
      ok "skill installed: $dst"
    done <<EOF
$TARGETS
EOF
  fi
fi

# ── 7. Chrome extension check & agy sign-in verification ────
printf '\n'
if [ "$SKIP_WEB_BRIDGE" != "1" ]; then
  BROWSER_ONLINE="$(node -e '
const http=require("http");
http.get("http://127.0.0.1:18765/status",(r)=>{let b="";r.on("data",c=>b+=c);r.on("end",()=>{
  try{process.stdout.write(String(JSON.parse(b).browserOnline===true))}catch{process.stdout.write("false")}
})}).on("error",()=>process.stdout.write("false"));
' 2>/dev/null)"
  if [ "$BROWSER_ONLINE" = "true" ]; then
    ok 'Chrome extension is already connected to Web Bridge!'
  else
    printf '[ACTION REQUIRED] Load the Chrome Extension to enable Gemini Web (/web, /sync, /pull):\n'
    printf '  1. Open Chrome -> chrome://extensions/\n'
    printf '  2. Enable "Developer mode" (top right)\n'
    printf '  3. Click "Load unpacked" and select:\n     %s\n' "$CHROME_EXT_DST"
    printf '  4. Sign in to https://gemini.google.com in Chrome\n'
    printf '  5. Verify: curl -s http://127.0.0.1:18765/status\n'
  fi

  if [ "$OPEN_CHROME_EXT" = "1" ]; then
    open "$CHROME_EXT_DST" 2>/dev/null || true
    for chrome in "/Applications/Google Chrome.app" "$HOME/Applications/Google Chrome.app"; do
      if [ -d "$chrome" ]; then
        open -a "$chrome" "chrome://extensions/" 2>/dev/null || true
        break
      fi
    done
  fi
fi

if [ "$SKIP_AUTH_CHECK" != "1" ]; then
  info 'Checking agy sign-in (agy -p /usage)...'
  AUTH_OUT="$(cd "$HOME" && run_with_timeout 45 "$AGY" -p /usage --output-format json 2>&1 || true)"
  if printf '%s' "$AUTH_OUT" | node -e '
let raw="";process.stdin.on("data",c=>raw+=c);process.stdin.on("end",()=>{
  const at=raw.indexOf("{");
  if(at<0)process.exit(1);
  try{
    const j=JSON.parse(raw.slice(at));
    process.exit(j&&j.status==="SUCCESS"?0:1);
  }catch{process.exit(1)}
});'; then
    ok 'agy signed in'
  else
    printf '\n[ACTION REQUIRED] All components are deployed, but Antigravity CLI (agy) is not signed in yet:\n'
    printf '  Run "agy" in a terminal (or VS Code Command Palette -> "ZeroG: Sign In to Antigravity CLI (agy)") to complete browser login.\n'
    [ -n "$AUTH_OUT" ] && printf '  Output: %s\n' "$AUTH_OUT"
    exit 3
  fi
fi

printf '\nNext: in VS Code / Cursor run "Developer: Reload Window", then press Cmd+Shift+Alt+N (or click the ZeroG status bar button).\n'
exit 0
