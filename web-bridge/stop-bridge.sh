#!/usr/bin/env bash
# macOS / Linux counterpart of stop-bridge.ps1: stop the Web Bridge by pid file,
# by command line match, and by the listening port.
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$DIR/bridge.pid"
PORT="${WEB_BRIDGE_PORT:-18765}"

PIDS=""

collect() {
  local pid="$1"
  [ -n "$pid" ] || return 0
  case " $PIDS " in
    *" $pid "*) return 0 ;;
  esac
  PIDS="$PIDS $pid"
}

if [ -f "$PID_FILE" ]; then
  collect "$(head -n 1 "$PID_FILE" 2>/dev/null || true)"
  rm -f "$PID_FILE"
fi

while read -r pid; do
  collect "$pid"
done <<EOF
$(ps -Ao pid=,command= 2>/dev/null | awk '/web-bridge\/server\.mjs/ && !/awk/ {print $1}')
EOF

if command -v lsof >/dev/null 2>&1; then
  while read -r pid; do
    collect "$pid"
  done <<EOF
$(lsof -ti "tcp:$PORT" 2>/dev/null || true)
EOF
fi

if [ -z "${PIDS// /}" ]; then
  echo "No running Gemini Web Bridge process found"
  exit 0
fi

for pid in $PIDS; do
  if kill -0 "$pid" 2>/dev/null; then
    kill -9 "$pid" 2>/dev/null || true
    echo "[OK] Stopped Gemini Web Bridge process (PID=$pid)"
  fi
done
