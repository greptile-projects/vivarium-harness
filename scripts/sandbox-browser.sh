#!/usr/bin/env bash
# Open or reuse the one headed Chrome instance in an arm sandbox and print its
# DevTools endpoint.
set -uo pipefail

export DISPLAY="${DISPLAY:-:99}"
port="${VIVARIUM_CDP_PORT:-9222}"
profile="${VIVARIUM_CHROME_PROFILE:-/home/agent/.vivarium/chromium}"
log="/var/log/vivarium/chromium.log"
bin="${CHROME_BIN:-/usr/bin/google-chrome-stable}"

running() { curl -fsS "http://127.0.0.1:$port/json/version" >/dev/null 2>&1; }

case "${1:-}" in
  -h | --help)
    sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
  --status)
    running || {
      echo "chrome is not running (start it with: browser <url>)" >&2
      exit 1
    }
    curl -fsS "http://127.0.0.1:$port/json/version"
    echo
    curl -fsS "http://127.0.0.1:$port/json/list"
    exit 0
    ;;
  --stop)
    pkill -f -- "--user-data-dir=$profile" >/dev/null 2>&1 || true
    echo "stopped"
    exit 0
    ;;
esac

url="${1:-about:blank}"
xdpyinfo -display "$DISPLAY" >/dev/null 2>&1 || {
  echo "browser: no X server on $DISPLAY — see /var/log/vivarium/xvfb.log" >&2
  exit 1
}
mkdir -p "$profile" "$(dirname "$log")"

if running; then
  "$bin" --user-data-dir="$profile" "$url" >>"$log" 2>&1 &
else
  geometry="$(xdpyinfo -display "$DISPLAY" | awk '/dimensions:/ {print $2; exit}')"
  window_size="${geometry/x/,}"
  nohup "$bin" \
    --user-data-dir="$profile" \
    --remote-debugging-port="$port" \
    --remote-allow-origins='*' \
    --disable-dev-shm-usage \
    --disable-gpu \
    --no-first-run \
    --no-default-browser-check \
    --disable-features=Translate \
    --window-position=0,0 \
    --window-size="${window_size:-1440,900}" \
    "$url" >>"$log" 2>&1 &

  waited=0
  until running; do
    if [ "$waited" -ge 30 ]; then
      echo "browser: Chrome did not open DevTools within 30s; see $log" >&2
      exit 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
fi

echo "chrome on $DISPLAY - DevTools: http://127.0.0.1:$port (profile: $profile)"
