# syntax=docker/dockerfile:1

# Toolchain image for one vivarium arm. Both arms share this image; they differ
# only in the checkout bind-mounted at /workspace, the GitHub token passed at run
# time, and whether the harness feeds Greptile reviews back. Neither arm has
# Greptile installed — the review runs in the harness, outside the container.
# No browser by design: Playwright/e2e is out of scope for this experiment.
# Node matches the host (24.x). Codex, bun, pnpm/yarn and Go ride on top.
FROM node:24-bookworm-slim

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
#   - safe.directory: /workspace is a bind mount owned by the host user while
#     the container runs as root, so git refuses it as "dubious ownership".
#   - the credential helper resolves GH_TOKEN at push time, so the arm's token
#     never lands in a remote URL, in argv, or in the reflog.
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

# Codex reads auth + config from CODEX_HOME. Mount the host's auth read-only at
# run time:  -v $HOME/.codex/auth.json:/codex/auth.json:ro
ENV CODEX_HOME=/codex
RUN mkdir -p /codex

WORKDIR /workspace

# tini as PID 1 reaps orphans from weeks of exec'd codex runs; sleep just idles
# so the harness can `docker exec` a fresh `codex mcp-server` per rung.
ENTRYPOINT ["tini", "--"]
CMD ["sleep", "infinity"]