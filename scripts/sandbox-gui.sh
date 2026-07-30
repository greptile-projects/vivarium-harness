#!/usr/bin/env bash
# Start the arm's screen inside its private sandbox microVM. Docker Engine is
# supplied and supervised by Docker Sandboxes; this script owns only the GUI.
set -uo pipefail

log_dir=/var/log/vivarium
run_dir=/run/vivarium
ready="$run_dir/ready"
display="${DISPLAY:-:99}"
screen="1440x900x24"
novnc_port=6080
vnc_port=5900

sudo install -d -o agent -g agent "$log_dir" "$run_dir"
sudo install -d -m 1777 -o root -g root /tmp/.X11-unix
rm -f "$ready"

if xdpyinfo -display "$display" >/dev/null 2>&1; then
  date -u +%FT%TZ >"$ready"
  exit 0
fi

Xvfb "$display" -screen 0 "$screen" -nolisten tcp -ac \
  >>"$log_dir/xvfb.log" 2>&1 &
xvfb_pid=$!

waited=0
while ! xdpyinfo -display "$display" >/dev/null 2>&1; do
  if ! kill -0 "$xvfb_pid" 2>/dev/null || [ "$waited" -ge 30 ]; then
    echo "vivarium-gui: Xvfb failed; see $log_dir/xvfb.log" >&2
    exit 1
  fi
  sleep 1
  waited=$((waited + 1))
done

sudo mkdir -p /run/dbus
sudo dbus-uuidgen --ensure >/dev/null 2>&1 || true
sudo dbus-daemon --system --fork >>"$log_dir/dbus.log" 2>&1 || true
xsetroot -solid '#202225' >>"$log_dir/xvfb.log" 2>&1 || true
fluxbox >>"$log_dir/fluxbox.log" 2>&1 &
fluxbox_pid=$!
x11vnc -display "$display" -rfbport "$vnc_port" -localhost \
  -forever -shared -nopw -noxdamage -quiet >>"$log_dir/x11vnc.log" 2>&1 &
x11vnc_pid=$!
websockify --web=/usr/share/novnc "$novnc_port" "localhost:$vnc_port" \
  >>"$log_dir/novnc.log" 2>&1 &
novnc_pid=$!

waited=0
until ss -lnt | grep -q ":$vnc_port " &&
  ss -lnt | grep -q ":$novnc_port "; do
  if ! kill -0 "$xvfb_pid" "$fluxbox_pid" "$x11vnc_pid" "$novnc_pid" 2>/dev/null ||
    [ "$waited" -ge 30 ]; then
    echo "vivarium-gui: desktop services failed; see $log_dir" >&2
    exit 1
  fi
  sleep 1
  waited=$((waited + 1))
done

date -u +%FT%TZ >"$ready"

# Keep the detached sbx exec session alive. Docker Sandboxes automatically
# stops a VM shortly after its last session exits; keeping this supervisor
# attached prevents that stop from killing the GUI between provisioning and
# the Codex MCP session.
while kill -0 "$xvfb_pid" "$fluxbox_pid" "$x11vnc_pid" "$novnc_pid" 2>/dev/null; do
  sleep 5
done
rm -f "$ready"
exit 1
