# syntax=docker/dockerfile:1

# Toolchain image for one vivarium arm. Both arms share this image; they differ
# only in the remote cloned into /workspace, the GitHub token passed at run
# time, and whether the harness feeds Greptile reviews back. Neither arm has
# Greptile installed — the review runs in the harness, outside the container.
# Node matches the host (24.x). Codex, bun, pnpm/yarn and Go ride on top, and a
# nested Docker engine plus an X display with chromium ride on top of those.
FROM node:24-bookworm

# Agent toolchain: git + GitHub CLI, the dev CLIs a cloned web project usually
# needs, and build deps. Extend for your target project's stack; note the host's
# python is 3.14 while Debian bookworm ships 3.11 (pin via pyenv if you need it).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git gnupg unzip \
      build-essential python3 python3-venv pipx \
      ripgrep jq sqlite3 openssl tree shellcheck \
      procps iproute2 lsof patch file tini git-lfs \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /etc/apt/keyrings/githubcli.gpg \
 && chmod go+r /etc/apt/keyrings/githubcli.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

# pnpm + yarn via corepack (bundled with Node 24), pinned and pre-fetched so
# nothing floats or prompts at runtime. Match your host versions.
RUN corepack enable \
 && corepack prepare pnpm@10.4.1 yarn@4.6.0 --activate

# Bun's install dir goes on PATH up front — `docker exec` never sources a login
# shell, so global bun binaries (codex, tsx, tsc, bunx) must resolve without one.
ENV BUN_INSTALL=/root/.bun \
    PATH=/root/.bun/bin:$PATH

# Bun, pinned to the host version so builds behave identically.
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.6"

# Common global JS CLIs seen on the host.
RUN bun install -g tsx typescript

# Go, pinned to the host's version and installed from the upstream tarball
# because Debian bookworm ships 1.19 — old enough that it refuses a module
# declaring a newer `go` line, which the arms' API does. Without this the arm
# writes Go, cannot run `go vet ./...` or `go build ./...` locally, and finds out
# from CI after the pull request is already open.
#
# GOTOOLCHAIN is deliberately left at its default: if a later `go.mod` asks for a
# newer toolchain, Go fetches it, exactly as CI's `setup-go` with
# `go-version-file` does. Pinning it to `local` would keep the image fixed at the
# cost of failing every build the moment the arms' own go.mod moves past it —
# and both arms read the same go.mod, so what floats floats symmetrically.
RUN GOARCH="$(dpkg --print-architecture)" \
 && curl -fsSL "https://go.dev/dl/go1.26.0.linux-${GOARCH}.tar.gz" -o /tmp/go.tar.gz \
 && tar -C /usr/local -xzf /tmp/go.tar.gz \
 && rm /tmp/go.tar.gz \
 && /usr/local/go/bin/go version

# Same reason bun's dir is on PATH above: `docker exec` sources no login shell,
# so `go` and anything `go install` drops in GOBIN must resolve without one.
ENV PATH=/usr/local/go/bin:/root/go/bin:$PATH

# And the other half of that, which ENV alone does not cover: a *login* shell.
# Debian's /etc/profile rewrites root's PATH from scratch, discarding everything
# above — so `bash -lc "bun install"` finds no bun, no go and no codex, while the
# identical command without `-l` works. The image used to get away with this by
# accident: bun's installer appended its own PATH line to /root/.bashrc. It stops
# doing that once BUN_INSTALL is already on PATH, which it now is, so nothing
# writes that file any more. Belt and braces, because which form the agent's
# shell tool uses is not ours to decide.
RUN printf '%s\n' \
      'PATH="/usr/local/go/bin:/root/go/bin:/root/.bun/bin:$PATH"' \
      'export PATH' \
      > /etc/profile.d/10-vivarium-path.sh

# Codex CLI (provides `codex mcp-server`), pinned to the host's version
# (brew cask codex-cli 0.145.0). Pinned rather than floating on purpose: a climb
# runs for weeks, and `latest` would silently change what the arms are made of
# partway through — an uncontrolled variable in the one place the experiment
# holds everything else constant. Bump this deliberately, between milestones.
RUN bun install -g @openai/codex@0.145.0

# Nothing in here may ever wait for a TTY. An expired token should fail the
# push loudly, not freeze the arm mid-subticket.
ENV GIT_TERMINAL_PROMPT=0 \
    GH_PROMPT=disabled

# Git, ready to commit and push from inside the container. Each line here is a
# failure the arm would otherwise hit halfway through a subticket, after the
# work was already done:
#   - safe.directory: keeps the workspace usable if deployment storage changes
#     from the container layer to a mounted volume later.
#   - the credential helper resolves GH_TOKEN at clone/fetch/push time, so the
#     arm's token never lands in a remote URL, in argv, or in the reflog.
#   - an identity, because `git commit` will not guess one. This is only the
#     fallback; arm-run.sh overrides it per arm so a commit says which arm
#     wrote it.
#   - the insteadOf rewrite: no ssh client or keys in the image, and lockfile
#     deps referencing git@github.com: would otherwise fail mid-install.
RUN git config --global --add safe.directory /workspace \
 && git config --global credential."https://github.com".helper '!gh auth git-credential' \
 && git config --global user.name "vivarium arm" \
 && git config --global user.email "arm@vivarium.invalid" \
 && git config --global init.defaultBranch main \
 && git config --global core.pager cat \
 && git config --global url."https://github.com/".insteadOf "git@github.com:" \
 && git lfs install

# Docker, nested — the arm gets an engine of its own, running inside this
# container, with its own images, containers, networks and volumes.
#
# Explicitly NOT the host's socket bind-mounted in. That is the cheap way to
# give a container docker, and it is unavailable here: the socket is the host
# daemon, so an arm holding it can `docker run -v /:/host` and read the *other*
# arm's checkout, the harness's `.env` with both arms' tokens, and every
# transcript under `results/` — one command, and the isolation the whole
# experiment rests on is gone, with the manifest still recording a normal run.
# It would also put both arms' containers in one namespace, where each can see
# the other exists. A nested daemon costs `--privileged` and a little startup
# time and keeps the boundary where the rest of the design assumes it is.
#
# Versions are pinned like everything else here: a climb runs for weeks, and a
# floating engine is an uncontrolled variable in the one place the experiment
# holds everything constant. Bump deliberately, between milestones.
ARG DOCKER_VERSION=5:29.1.3-1~debian.12~bookworm
RUN curl -fsSL https://download.docker.com/linux/debian/gpg \
      -o /etc/apt/keyrings/docker.asc \
 && chmod go+r /etc/apt/keyrings/docker.asc \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" \
      > /etc/apt/sources.list.d/docker.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      "docker-ce=${DOCKER_VERSION}" "docker-ce-cli=${DOCKER_VERSION}" \
      containerd.io docker-buildx-plugin docker-compose-plugin \
      iptables uidmap \
 && rm -rf /var/lib/apt/lists/* \
 && update-alternatives --set iptables /usr/sbin/iptables-legacy \
 && update-alternatives --set ip6tables /usr/sbin/ip6tables-legacy

# The nested daemon's storage cannot live on the container's own filesystem:
# that is overlayfs, and overlay2 refuses to stack on itself. This covers a bare
# `docker run` with an anonymous volume; the harness names a fresh one per arm
# and subticket, then removes it at teardown. Reusing it would carry a warm
# cache—and potentially task-created images—into an otherwise amnesic worker.
VOLUME /var/lib/docker

# A desktop and a browser. The arms build a web application, and until now
# anything that had to be *looked at* — a rendered page, a Playwright run, an
# e2e suite — was a thing the arm could only reason about and hand to CI. Xvfb
# is the screen, fluxbox places windows on it (an agent driving a browser it
# cannot focus loses its keystrokes), and x11vnc + noVNC put that screen on a
# port so a human can watch the arm work.
#
# These float with Debian's archive rather than being pinned: security updates
# supersede chromium builds and the old versions leave the mirror, so a pin here
# would break the build outright some week rather than hold anything steady.
# Both arms are built from the same Dockerfile at the same time, so whatever
# they float to, they float to together.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      xvfb x11vnc fluxbox novnc websockify x11-utils x11-xserver-utils xauth \
      dbus dbus-x11 dbus-system-bus-common \
      xdotool scrot \
      chromium chromium-driver \
      fonts-liberation fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/* \
 && ln -sf /usr/share/novnc/vnc.html /usr/share/novnc/index.html

# The display the arm's tools find without being told, and the chromium every
# JS browser library looks for by env var. Puppeteer and friends otherwise
# download a second copy of a browser that is already installed.
ENV DISPLAY=:99 \
    CHROME_BIN=/usr/bin/chromium \
    CHROME_PATH=/usr/bin/chromium \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    VIVARIUM_DOCKER=1 \
    VIVARIUM_GUI=1

# Debian's /usr/bin/chromium is a wrapper that sources /etc/chromium.d/*, so
# these reach a plain `chromium` too — not just the `browser` helper. Root has
# no usable chromium sandbox (the container is the boundary instead), and the
# default 64MB /dev/shm is where chromium dies mid-page rather than at startup.
# `--test-type` is only there to suppress the "unsupported command-line flag"
# infobar the first of those triggers: it covers the top of every page, so a
# screenshot the arm takes to check its own layout is a screenshot of a warning
# about how the browser was started.
RUN printf '%s\n' \
      'export CHROMIUM_FLAGS="$CHROMIUM_FLAGS --no-sandbox --disable-dev-shm-usage --disable-gpu --test-type"' \
      > /etc/chromium.d/00-vivarium

# Three bits of fluxbox configuration, all of them things that otherwise end up
# in every screenshot the arm takes of its own work:
#   menu     — without one, fluxbox's default menu is what it is.
#   overlay  — `background: none` stops fluxbox running the style's `fbsetbg`,
#              which needs ImageMagick's `display` to paint a wallpaper, does
#              not find it, and reports that by leaving an xmessage dialog
#              sitting on the screen for the life of the container. arm-init
#              paints a flat colour instead.
#   apps     — chromium undecorated and maximized. A titlebar the window is
#              positioned above puts the tab strip off the top of the screen,
#              and a browser filling two thirds of the screen renders the page
#              at a viewport nobody chose.
RUN mkdir -p /root/.fluxbox \
 && printf '%s\n' \
      '[begin] (vivarium)' \
      '[exec] (chromium) {browser}' \
      '[workspaces] (workspaces)' \
      '[restart] (restart)' \
      '[end]' \
      > /root/.fluxbox/menu \
 && printf '%s\n' 'background: none' > /root/.fluxbox/overlay \
 && printf '%s\n' \
      '[app] (class=Chromium)' \
      '  [Deco]      {NONE}' \
      '  [Maximized] {yes}' \
      '[end]' \
      > /root/.fluxbox/apps

# The container's own two entry points: what brings the services up, and the
# one obvious way for the arm to get a browser on the screen.
COPY scripts/arm-init.sh /usr/local/bin/vivarium-init
COPY scripts/arm-browser.sh /usr/local/bin/browser
RUN chmod 0755 /usr/local/bin/vivarium-init /usr/local/bin/browser

# Codex reads auth + config from CODEX_HOME. Mount the host's auth read-only at
# run time:  -v $HOME/.codex/auth.json:/codex/auth.json:ro
ENV CODEX_HOME=/codex
RUN mkdir -p /codex /workspace /vivarium

WORKDIR /workspace

# tini as PID 1 reaps orphans from weeks of exec'd codex runs; vivarium-init
# starts dockerd and the GUI and then execs CMD, which just idles so the harness
# can `docker exec` a fresh `codex mcp-server` per subticket.
ENTRYPOINT ["tini", "--", "vivarium-init"]
CMD ["sleep", "infinity"]
