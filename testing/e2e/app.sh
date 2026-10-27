#!/usr/bin/env bash
# Launch the real Ternlux app (real profile, real connections) with a Chrome
# DevTools Protocol port open, so the Playwright MCP server in .mcp.json can
# drive it. Nothing about the app is changed — the port is a CLI switch.
#
#   testing/e2e/app.sh start              dev build (react dev server on :3000 + electron .)
#   testing/e2e/app.sh start --packaged   the installed /Applications/Ternlux.app
#   testing/e2e/app.sh status             is the CDP port up, which pages it exposes
#   testing/e2e/app.sh logmark            print the main-process log's current line count
#   testing/e2e/app.sh logs [FROM_LINE]   main-process log from FROM_LINE (default: last 80 lines)
#   testing/e2e/app.sh stop               quit the instance this script started
set -euo pipefail

PORT="${TERNLUX_CDP_PORT:-9333}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RUN_DIR="$ROOT/testing/e2e/runs"
LOG_DIR="$RUN_DIR/logs"
APP_PID_FILE="$RUN_DIR/.app.pid"
DEV_PID_FILE="$RUN_DIR/.devserver.pid"
MAIN_LOG="$LOG_DIR/main-latest.log"
USER_DATA="$HOME/Library/Application Support/Ternlux"
PACKAGED_BIN="/Applications/Ternlux.app/Contents/MacOS/Ternlux"

mkdir -p "$LOG_DIR"

cdp_up() { curl -sf "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; }
dev_server_up() { curl -sf "http://localhost:3000" >/dev/null 2>&1; }

# App pages only — DevTools windows are CDP targets too.
app_pages() {
  curl -sf "http://127.0.0.1:$PORT/json/list" 2>/dev/null |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      for (const t of JSON.parse(s||"[]"))
        if (t.type==="page" && !t.url.startsWith("devtools://")) console.log(t.title+"  "+t.url);
    })'
}

# Any Ternlux/Electron process on the real profile that is NOT ours. Two
# instances on one profile would both write the same NeDB files.
other_instance_pids() {
  pgrep -f -- "--user-data-dir=$USER_DATA" 2>/dev/null || true
}

wait_for() { # seconds, description, command...
  local secs=$1 what=$2; shift 2
  for ((i = 0; i < secs; i++)); do
    if "$@"; then return 0; fi
    sleep 1
  done
  echo "Timed out after ${secs}s waiting for $what" >&2
  return 1
}

cmd_start() {
  local packaged=0
  [[ "${1:-}" == "--packaged" ]] && packaged=1

  if cdp_up; then
    echo "Already running with CDP on port $PORT:"
    app_pages
    return 0
  fi

  if [[ -n "$(other_instance_pids)" ]]; then
    cat >&2 <<EOF
Ternlux is already running on your profile without the debugging port
(e.g. from 'npm run electron-dev' or the installed app). Quit that Electron
window first (Cmd+Q) — the dev server on :3000 can keep running and will be
reused — then run this again.
EOF
    return 2
  fi

  local stamp; stamp="$(date +%Y%m%d-%H%M%S)"
  local log="$LOG_DIR/main-$stamp.log"
  ln -sf "$(basename "$log")" "$MAIN_LOG"

  if ((packaged)); then
    [[ -x "$PACKAGED_BIN" ]] || { echo "Not installed: $PACKAGED_BIN" >&2; return 1; }
    nohup "$PACKAGED_BIN" --remote-debugging-port="$PORT" >"$log" 2>&1 &
    echo $! >"$APP_PID_FILE"
  else
    if ! dev_server_up; then
      echo "Starting react dev server on :3000 (log: $LOG_DIR/devserver.log)…"
      (cd "$ROOT" && BROWSER=none DANGEROUSLY_DISABLE_HOST_CHECK=true \
        nohup "$ROOT/node_modules/.bin/react-scripts" start >"$LOG_DIR/devserver.log" 2>&1 &
        echo $! >"$DEV_PID_FILE")
      wait_for 240 "the dev server on :3000" dev_server_up
    else
      echo "Reusing the dev server already on :3000."
    fi
    (cd "$ROOT" && nohup "$ROOT/node_modules/.bin/electron" . --remote-debugging-port="$PORT" >"$log" 2>&1 &
      echo $! >"$APP_PID_FILE")
  fi

  wait_for 90 "CDP on port $PORT" cdp_up
  wait_for 60 "the app window" bash -c "[[ -n \"\$(curl -sf http://127.0.0.1:$PORT/json/list | grep -v devtools:// | grep '\"type\": \"page\"')\" ]]"
  echo "Ternlux is up. CDP: http://127.0.0.1:$PORT   main-process log: $log"
  app_pages
}

cmd_status() {
  if cdp_up; then
    echo "CDP up on port $PORT. Pages:"
    app_pages
  else
    echo "CDP not reachable on port $PORT."
    [[ -n "$(other_instance_pids)" ]] && echo "(Ternlux IS running on your profile, but without the debugging port.)"
    return 1
  fi
}

cmd_logmark() { [[ -f "$MAIN_LOG" ]] && wc -l <"$MAIN_LOG" | tr -d ' ' || echo 0; }

cmd_logs() {
  [[ -f "$MAIN_LOG" ]] || { echo "No main-process log yet." >&2; return 1; }
  if [[ -n "${1:-}" ]]; then tail -n +"$(($1 + 1))" "$MAIN_LOG"; else tail -n 80 "$MAIN_LOG"; fi
}

kill_tree() { # pid — children first, then the pid itself
  local pid=$1
  for child in $(pgrep -P "$pid" 2>/dev/null); do kill_tree "$child"; done
  kill -TERM "$pid" 2>/dev/null || true
}

cmd_stop() {
  if [[ -f "$APP_PID_FILE" ]]; then
    kill_tree "$(cat "$APP_PID_FILE")"
    rm -f "$APP_PID_FILE"
    echo "Stopped the app."
  else
    echo "No app started by this script."
  fi
  # Only stop the dev server if this script started it.
  if [[ -f "$DEV_PID_FILE" ]]; then
    kill_tree "$(cat "$DEV_PID_FILE")"
    rm -f "$DEV_PID_FILE"
    echo "Stopped the dev server this script started."
  fi
}

case "${1:-}" in
  start) shift; cmd_start "$@" ;;
  status) cmd_status ;;
  logmark) cmd_logmark ;;
  logs) shift; cmd_logs "$@" ;;
  stop) cmd_stop ;;
  *) sed -n '2,13p' "$0"; exit 1 ;;
esac
