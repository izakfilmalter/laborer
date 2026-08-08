FROM node:24.11.1-bookworm

RUN apt-get update && apt-get install -y \
  g++ \
  curl \
  git \
  jq \
  make \
  python3 \
  tini \
  unzip \
  && rm -rf /var/lib/apt/lists/*

# Match both workspace package managers. Sandcastle installs current and next in
# each worktree so an issue can target either implementation.
ENV BUN_INSTALL=/usr/local/bun
ENV BUN_INSTALL_CACHE_DIR=/home/agent/.bun/install/cache
ENV PATH=/usr/local/bun/bin:$PATH
RUN curl -fsSL https://bun.sh/install | bash -s -- bun-v1.3.5

RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
  && apt-get update && apt-get install -y gh \
  && rm -rf /var/lib/apt/lists/*

ARG AGENT_UID=1000
ARG AGENT_GID=1000

RUN groupmod -o -g $AGENT_GID node \
  && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node

RUN npm install -g @opencode-ai/cli@0.0.0-next-16573
RUN npm install -g node-gyp@13.0.1

RUN mkdir -p \
  /home/agent/.bun/install/cache \
  /home/agent/.cache \
  /home/agent/.config/opencode \
  /home/agent/.local/share/opencode \
  /home/agent/.local/state \
  && chown -R $AGENT_UID:$AGENT_GID \
  /home/agent/.bun \
  /home/agent/.cache \
  /home/agent/.config \
  /home/agent/.local

USER ${AGENT_UID}:${AGENT_GID}

# Populate the agent user's Bun cache from lockfiles without baking a worktree's
# node_modules into the image. Runtime frozen installs still validate and link
# each worktree, but package archives do not need to be downloaded again.
COPY --chown=$AGENT_UID:$AGENT_GID current/package.json current/bun.lock /tmp/sandcastle-current/
COPY --chown=$AGENT_UID:$AGENT_GID current/apps/desktop/package.json /tmp/sandcastle-current/apps/desktop/
COPY --chown=$AGENT_UID:$AGENT_GID current/apps/web/package.json /tmp/sandcastle-current/apps/web/
COPY --chown=$AGENT_UID:$AGENT_GID current/packages/config/package.json /tmp/sandcastle-current/packages/config/
COPY --chown=$AGENT_UID:$AGENT_GID current/packages/env/package.json /tmp/sandcastle-current/packages/env/
COPY --chown=$AGENT_UID:$AGENT_GID current/packages/file-watcher/package.json /tmp/sandcastle-current/packages/file-watcher/
COPY --chown=$AGENT_UID:$AGENT_GID current/packages/mcp/package.json /tmp/sandcastle-current/packages/mcp/
COPY --chown=$AGENT_UID:$AGENT_GID current/packages/server/package.json /tmp/sandcastle-current/packages/server/
COPY --chown=$AGENT_UID:$AGENT_GID current/packages/shared/package.json /tmp/sandcastle-current/packages/shared/
COPY --chown=$AGENT_UID:$AGENT_GID current/packages/terminal/package.json /tmp/sandcastle-current/packages/terminal/
RUN bun install --cwd /tmp/sandcastle-current --frozen-lockfile --ignore-scripts \
  && rm -rf /tmp/sandcastle-current

COPY --chown=$AGENT_UID:$AGENT_GID next/package.json next/bun.lock /tmp/sandcastle-next/
RUN bun install --cwd /tmp/sandcastle-next --frozen-lockfile --ignore-scripts \
  && rm -rf /tmp/sandcastle-next

WORKDIR /home/agent
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "sleep", "infinity"]
