#!/usr/bin/env bash
# Provision the reusable Vivarium image from Docker's Codex+Docker sandbox
# template. Run inside a disposable template-build sandbox; sandbox-build.sh
# snapshots the result only after every tool reports ready.
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

sudo apt-get update
sudo apt-get install -y --no-install-recommends \
  ca-certificates curl git gnupg unzip \
  build-essential python3 python3-venv pipx \
  ripgrep jq sqlite3 openssl tree shellcheck \
  procps iproute2 lsof patch file git-lfs \
  xvfb x11vnc fluxbox novnc websockify x11-utils x11-xserver-utils xauth \
  dbus dbus-x11 dbus-system-bus-common \
  xdotool scrot \
  fonts-liberation fonts-noto-color-emoji

# Ubuntu ships Chromium as a snap transition package. Sandboxes do not run
# snapd, so install Google's normal Debian package instead.
curl -fsSL \
  https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
  -o /tmp/google-chrome-stable_current_amd64.deb
sudo apt-get install -y /tmp/google-chrome-stable_current_amd64.deb
rm -f /tmp/google-chrome-stable_current_amd64.deb

# Match the experiment's pinned runtime and Codex CLI. The stock Codex sandbox
# already supplies Node, Go, gh, Docker Engine, buildx and Compose.
export BUN_INSTALL=/home/agent/.bun
curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.6"
/home/agent/.bun/bin/bun install -g tsx typescript
npm install -g @openai/codex@0.146.0

sudo ln -sf /home/agent/.bun/bin/bun /usr/local/bin/bun
sudo ln -sf /home/agent/.bun/bin/bunx /usr/local/bin/bunx
sudo ln -sf /home/agent/.bun/bin/tsx /usr/local/bin/tsx
sudo ln -sf /home/agent/.bun/bin/tsc /usr/local/bin/tsc
sudo ln -sf /usr/bin/google-chrome-stable /usr/local/bin/chromium
sudo ln -sf /usr/share/novnc/vnc.html /usr/share/novnc/index.html

sudo install -d -o agent -g agent \
  /workspace /vivarium /var/log/vivarium /run/vivarium \
  /home/agent/.fluxbox /home/agent/.vivarium

cat >/tmp/vivarium-fluxbox-menu <<'EOF'
[begin] (vivarium)
[exec] (chromium) {browser}
[workspaces] (workspaces)
[restart] (restart)
[end]
EOF
sudo install -o agent -g agent -m 0644 \
  /tmp/vivarium-fluxbox-menu /home/agent/.fluxbox/menu
printf '%s\n' 'background: none' >/home/agent/.fluxbox/overlay
cat >/home/agent/.fluxbox/apps <<'EOF'
[app] (class=Google-chrome)
  [Deco]      {NONE}
  [Maximized] {yes}
[end]
EOF

git config --global --add safe.directory /workspace
git config --global credential."https://github.com".helper '!gh auth git-credential'
git config --global user.name "vivarium arm"
git config --global user.email "arm@vivarium.invalid"
git config --global init.defaultBranch main
git config --global core.pager cat
git config --global url."https://github.com/".insteadOf "git@github.com:"
git lfs install

sudo apt-get clean
sudo rm -rf /var/lib/apt/lists/*

bun --version
codex --version
go version
docker --version
docker buildx version
docker compose version
google-chrome-stable --version
