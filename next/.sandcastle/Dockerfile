FROM node:24.11.1-bookworm

RUN apt-get update && apt-get install -y \
  curl \
  git \
  jq \
  unzip \
  && rm -rf /var/lib/apt/lists/*

# Match package.json. Sandcastle installs the next workspace in each worktree.
ENV BUN_INSTALL=/usr/local/bun
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

RUN npm install -g opencode-ai@1.18.4

RUN mkdir -p \
  /home/agent/.cache \
  /home/agent/.config/opencode \
  /home/agent/.local/share/opencode \
  /home/agent/.local/state \
  && chown -R $AGENT_UID:$AGENT_GID \
  /home/agent/.cache \
  /home/agent/.config \
  /home/agent/.local

USER ${AGENT_UID}:${AGENT_GID}
WORKDIR /home/agent
ENTRYPOINT ["sleep", "infinity"]
