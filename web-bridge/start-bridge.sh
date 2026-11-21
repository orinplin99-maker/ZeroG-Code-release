#!/usr/bin/env bash
# macOS / Linux counterpart of start-bridge.ps1: start the Web Bridge detached
# from the calling terminal so "Reload Window" does not kill it.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$DIR/bridge.pid"
LOG_FILE="$DIR/bridge.log"
SERVER_SCRIPT="$DIR/server.mjs"

CWD="${WEB_BRIDGE_CWD:-$PWD}"
PORT="${WEB_BRIDGE_PORT:-18765}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    -c|--cwd) CWD="${2:-}"; shift 2 ;;
    -p|--port) PORT="${2:-}"; shift 2 ;;
    -h|--help)
      echo "Usage: $0 [--cwd <dir>] [--port <port>]"
      exit 0
      ;;
    *) echo "[FAIL] Unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [ ! -f "$SERVER_SCRIPT" ]; then
  echo "[FAIL] Missing $SERVER_SCRIPT" >&2
  exit 1
fi

if [ -f "$PID_FILE" ]; then
  OLD_PID="$(head -n 1 "$PID_FILE" 2>/dev/null || true)"
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    if ps -p "$OLD_PID" -o command= 2>/dev/null | grep -q "server\.mjs"; then
      echo "[OK] ZeroG Code Web Bridge is already running (PID=$OLD_PID, http://127.0.0.1:$PORT)"
      exit 0
    fi
  fi
  rm -f "$PID_FILE"
fi

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "[FAIL] node not found on PATH (need Node.js >= 18)" >&2
  exit 1
fi

export WEB_BRIDGE_CWD="$CWD"
export WEB_BRIDGE_PORT="$PORT"

cd "$DIR"
nohup "$NODE_BIN" "$SERVER_SCRIPT" >>"$LOG_FILE" 2>&1 &
NEW_PID=$!
echo "$NEW_PID" >"$PID_FILE"
sleep 1.2

if curl -fsS --max-time 3 "http://127.0.0.1:$PORT/status" >/dev/null 2>&1; then
  echo "[OK] ZeroG Code Web Bridge started (PID=$NEW_PID, http://127.0.0.1:$PORT, cwd=$CWD)"
else
  echo "[WARN] Bridge process started (PID=$NEW_PID), still initializing. Check $LOG_FILE"
fi
