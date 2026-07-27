#!/usr/bin/env bash
# vivarium-init — what an arm container brings up before the harness execs a
# codex session into it, then whatever CMD asked for (normally `sleep infinity`).
#
# Two services, both identical in both arms — the arms differ in their checkout
# and their token, never in what is running around them:
#
#   dockerd  a Docker engine of the arm's own, nested inside this container.
#            Never the host's socket: see the Dockerfile for why that trade is
#            not available here.
#   the GUI  an X display, a window manager, and a VNC/noVNC pair onto it, so
#            `chromium` has somewhere to draw and a human can watch it.
#
# Either can be switched off with VIVARIUM_DOCKER=0 / VIVARIUM_GUI=0, which is
# for smoke tests; a real run has both. Failing to start one is NOT fatal — the
# container stays up without writing its readiness file, so `arm-run.sh` reports
# the failure and the logs under /var/log/vivarium survive to be read. Dying
# here would take `--rm` with it and delete the evidence.
set -uo pipefail

log_dir=/var/log/vivarium
run_dir=/run/vivarium
ready="$run_dir/ready"
mkdir -p "$log_dir" "$run_dir"
rm -f "$ready"

say() { printf '[vivarium-init] %s\n' "$*"; }
warn() { printf '[vivarium-init] warning: %s\n' "$*" >&2; }

want_docker="${VIVARIUM_DOCKER:-1}"
want_gui="${VIVARIUM_GUI:-1}"
display="${DISPLAY:-:99}"
screen="${VIVARIUM_SCREEN:-1440x900x24}"
novnc_port="${VIVARIUM_NOVNC_PORT:-6080}"
vnc_port="${VIVARIUM_VNC_PORT:-5900}"
docker_timeout="${VIVARIUM_DOCKER_TIMEOUT:-60}"

ok=1

# --- the nested engine -------------------------------------------------------
start_dockerd() {
  # /var/lib/docker has to be a volume. The container's own rootfs is overlayfs
  # and overlay2 will not stack on it, so a missing volume shows up as a daemon
  # that starts and immediately exits — a confusing failure worth naming here
  # rather than leaving in the log.
  if [ "$(stat -f -c %T /var/lib/docker 2>/dev/null || echo unknown)" = "overlayfs" ]; then
    warn "/var/lib/docker is on the container's overlayfs rootfs; overlay2 cannot stack on it. Start the container with a volume mounted there (arm-run.sh does)."
  fi

  say "starting dockerd (nested)"
  dockerd --host=unix:///var/run/docker.sock >>"$log_dir/dockerd.log" 2>&1 &
  local pid=$!

  local waited=0
  while [ "$waited" -lt "$docker_timeout" ]; do
    if docker info >/dev/null 2>&1; then
      say "dockerd ready: $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo unknown)"
      return 0
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      warn "dockerd exited during startup — the container almost certainly needs --privileged; see $log_dir/dockerd.log"
      return 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
  warn "dockerd did not answer within ${docker_timeout}s; see $log_dir/dockerd.log"
  return 1
}

# --- the display -------------------------------------------------------------
start_gui() {
  say "starting X on $display ($screen)"
  Xvfb "$display" -screen 0 "$screen" -nolisten tcp -ac >>"$log_dir/xvfb.log" 2>&1 &
  local pid=$!

  local waited=0
  while ! xdpyinfo -display "$display" >/dev/null 2>&1; do
    if ! kill -0 "$pid" 2>/dev/null; then
      warn "Xvfb exited during startup; see $log_dir/xvfb.log"
      return 1
    fi
    if [ "$waited" -ge 30 ]; then
      warn "X did not come up within 30s; see $log_dir/xvfb.log"
      return 1
    fi
    sleep 1
    waited=$((waited + 1))
  done

  # Chromium is far quieter with a bus to talk to, and some of what it does
  # without one is hang rather than warn. The machine id is not in the image
  # (nothing writes one at build time) and dbus refuses to start without it.
  mkdir -p /run/dbus
  dbus-uuidgen --ensure >/dev/null 2>&1 || true
  dbus-daemon --system --fork >>"$log_dir/dbus.log" 2>&1 ||
    warn "no system dbus; chromium will be noisier"

  # A flat desktop colour. fluxbox's own wallpaper path is switched off in the
  # image (it needs ImageMagick and leaves an error dialog on the screen when it
  # does not find it), and an unpainted root window is whatever noise the X
  # server started with.
  xsetroot -solid '#202225' >>"$log_dir/xvfb.log" 2>&1 || true

  # A window manager, so windows are placed, sized and focusable rather than
  # stacked at 0,0 with no decoration — an agent driving a browser it cannot
  # focus gets keystrokes swallowed.
  fluxbox >>"$log_dir/fluxbox.log" 2>&1 &

  # x11vnc binds loopback only: the one thing that should reach it is websockify
  # in this same container. Anything the arm starts under its nested dockerd
  # sits on the inner bridge and can address this container, and the screen the
  # arm is working on is not something an inner container needs.
  x11vnc -display "$display" -rfbport "$vnc_port" -localhost \
    -forever -shared -nopw -noxdamage -quiet >>"$log_dir/x11vnc.log" 2>&1 &

  # noVNC on 0.0.0.0 so Docker can publish it; arm-run.sh publishes it on the
  # host's loopback only.
  websockify --web=/usr/share/novnc "$novnc_port" "localhost:$vnc_port" \
    >>"$log_dir/novnc.log" 2>&1 &

  say "GUI ready: noVNC on :$novnc_port, VNC on localhost:$vnc_port"
  return 0
}

if [ "$want_docker" != "0" ]; then
  start_dockerd || ok=0
else
  say "docker disabled (VIVARIUM_DOCKER=0)"
fi

if [ "$want_gui" != "0" ]; then
  start_gui || ok=0
else
  say "GUI disabled (VIVARIUM_GUI=0)"
fi

if [ "$ok" = 1 ]; then
  date -u +%FT%TZ >"$ready"
  say "ready"
else
  warn "came up degraded — not writing $ready"
fi

# Hand over to CMD. `exec`, so the container's lifetime is CMD's and signals
# reach it directly through tini.
exec "$@"
