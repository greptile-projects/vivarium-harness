#!/usr/bin/env bash
# browser — open a URL in this container's chromium, on this container's screen.
#
# Installed in the arm image as `browser`. It exists so the arm has one obvious
# way in: a plain `chromium https://…` works too, but it returns nothing an
# agent can act on, and a second invocation with a different profile dir starts
# a second unrelated browser. This keeps one long-lived instance on one profile
# and prints the DevTools endpoint, which is how a headless caller actually
# drives the page (CDP over http://127.0.0.1:9222 — Puppeteer's
# `connect({browserURL})`, Playwright's `connectOverCDP`, or plain `curl`).
#
# Usage:
#   browser [url]     start chromium (or focus the running one) on that URL
#   browser --status  print the DevTools endpoint and open targets, or exit 1
#   browser --stop    close the running instance
set -uo pipefail

port="${VIVARIUM_CDP_PORT:-9222}"
profile="${VIVARIUM_CHROME_PROFILE:-/root/.vivarium/chromium}"
log="/var/log/vivarium/chromium.log"
bin="${CHROME_BIN:-/usr/bin/chromium}"

running() { curl -fsS "http://127.0.0.1:$port/json/version" >/dev/null 2>&1; }

case "${1:-}" in
  -h | --help)
    sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
  --status)
    if ! running; then
      echo "chromium is not running (start it with: browser <url>)" >&2
      exit 1
    fi
    curl -fsS "http://127.0.0.1:$port/json/version"
    echo
    curl -fsS "http://127.0.0.1:$port/json/list"
    exit 0
    ;;
  --stop)
    running && curl -fsS -X PUT "http://127.0.0.1:$port/json/close" >/dev/null 2>&1
    pkill -f -- "--user-data-dir=$profile" >/dev/null 2>&1
    echo "stopped"
    exit 0
    ;;
esac

url="${1:-about:blank}"

if [ -z "${DISPLAY:-}" ]; then
  echo "browser: DISPLAY is unset — the container's GUI is not running" >&2
  exit 1
fi
if ! xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then
  echo "browser: no X server on $DISPLAY — see /var/log/vivarium/xvfb.log" >&2
  exit 1
fi

mkdir -p "$profile" "$(dirname "$log")"

if running; then
  # Same profile dir, so this hands the URL to the instance already on screen
  # instead of starting a second browser next to it.
  "$bin" --user-data-dir="$profile" "$url" >>"$log" 2>&1 &
else
  # Fill the screen. `--start-maximized` is advisory — it asks the window
  # manager, which may or may not oblige — and a browser occupying two thirds of
  # a screenshot is a browser whose layout the arm is checking at the wrong
  # viewport size.
  geometry="$(xdpyinfo -display "$DISPLAY" | awk '/dimensions:/ {print $2; exit}')"
  window_size="${geometry/x/,}"

  # --no-sandbox: the arm runs as root, where chromium's own sandbox refuses to
  # start. The container is the boundary here, as it is for everything else the
  # arm does. --test-type only hides the infobar that flag otherwise pins to the
  # top of every page.
  nohup "$bin" \
    --user-data-dir="$profile" \
    --remote-debugging-port="$port" \
    --remote-allow-origins='*' \
    --no-sandbox \
    --test-type \
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
      echo "browser: chromium did not open a DevTools port within 30s; see $log" >&2
      exit 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
fi

echo "chromium on $DISPLAY - DevTools: http://127.0.0.1:$port (profile: $profile)"
