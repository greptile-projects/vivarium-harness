# syntax=docker/dockerfile:1

# Reusable Docker Sandbox template for both arms and Greg. The base is Docker's
# Codex image with a private Docker Engine baked into the Firecracker microVM.
# It is not a normal host-side arm container and never receives the host Docker
# socket.
FROM docker.io/docker/sandbox-templates:codex-docker

COPY --chown=agent:agent scripts/sandbox-setup.sh /tmp/vivarium-setup

USER agent
RUN chmod 0755 /tmp/vivarium-setup \
 && /tmp/vivarium-setup \
 && rm -f /tmp/vivarium-setup

USER root
COPY scripts/sandbox-gui.sh /usr/local/bin/vivarium-gui
COPY scripts/sandbox-browser.sh /usr/local/bin/browser
COPY scripts/sandbox-init.sh /usr/local/bin/vivarium-init
COPY scripts/sandbox-sync.sh /usr/local/bin/vivarium-sync
RUN chmod 0755 \
    /usr/local/bin/vivarium-gui \
    /usr/local/bin/browser \
    /usr/local/bin/vivarium-init \
    /usr/local/bin/vivarium-sync
USER agent

ENV DISPLAY=:99 \
    CHROME_BIN=/usr/bin/google-chrome-stable \
    CHROME_PATH=/usr/bin/google-chrome-stable \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable \
    GIT_TERMINAL_PROMPT=0 \
    GH_PROMPT=disabled

WORKDIR /workspace
