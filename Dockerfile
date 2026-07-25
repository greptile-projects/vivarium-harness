# syntax=docker/dockerfile:1

# Toolchain image for one vivarium arm. Both arms share this image; they differ
# only in the checkout bind-mounted at /workspace, the GitHub token passed at run
# time, and whether the harness feeds Greptile reviews back. Neither arm has
# Greptile installed — the review runs in the harness, outside the container.
# Node matches the host (24.x). Codex, bun, pnpm/yarn ride on top.
FROM node:24-bookworm-slim

# Agent toolchain: git + GitHub CLI, the dev CLIs a cloned web project usually
# needs, and build deps. Extend for your target project's stack; note the host's
# python is 3.14 while Debian bookworm ships 3.11 (pin via pyenv if you need it).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git gnupg unzip \
      build-essential python3 python3-venv pipx \
      ripgrep jq sqlite3 openssl tree shellcheck \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /etc/apt/keyrings/githubcli.gpg \
 && chmod go+r /etc/apt/keyrings/githubcli.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

# pnpm + yarn via corepack (bundled with Node 24).
RUN corepack enable

# Bun, pinned to the host version so builds behave identically.
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.6" \
 && ln -s /root/.bun/bin/bun /usr/local/bin/bun

# Common global JS CLIs seen on the host.
RUN npm install -g tsx typescript vercel

# Codex CLI (provides `codex mcp-server`), pinned to the host's version
# (brew cask codex-cli 0.145.0). Pinned rather than floating on purpose: a climb
# runs for weeks, and `latest` would silently change what the arms are made of
# partway through — an uncontrolled variable in the one place the experiment
# holds everything else constant. Bump this deliberately, between milestones.
RUN npm install -g @openai/codex@0.145.0

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
RUN git config --global --add safe.directory /workspace \
 && git config --global credential."https://github.com".helper '!gh auth git-credential' \
 && git config --global user.name "vivarium arm" \
 && git config --global user.email "arm@vivarium.invalid" \
 && git config --global init.defaultBranch main

# Codex reads auth + config from CODEX_HOME. Mount the host's auth read-only at
# run time:  -v $HOME/.codex/auth.json:/codex/auth.json:ro
ENV CODEX_HOME=/codex
RUN mkdir -p /codex

WORKDIR /workspace

# Idle so the harness can `docker exec` a fresh `codex mcp-server` per rung.
CMD ["sleep", "infinity"]
