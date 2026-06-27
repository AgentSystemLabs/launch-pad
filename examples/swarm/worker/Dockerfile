# syntax=docker/dockerfile:1
FROM node:24-bookworm

WORKDIR /opt/swarm

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git openssh-client gh jq \
  && rm -rf /var/lib/apt/lists/*

# cursor-agent CLI
RUN curl -fsSL https://cursor.com/install | bash
ENV PATH="/root/.local/bin:${PATH}"

# Swarm bundle (prompt, loops, scripts) — target repo cloned at runtime
COPY prompt.md ./prompt.md
COPY loops ./loops
COPY worker ./worker
COPY .cursor ./.cursor
COPY mcp /opt/swarm-mcp
RUN chmod +x /opt/swarm/worker/entrypoint.sh /opt/swarm/worker/run-loop.sh

ENV WORKSPACE=/workspace/target
ENV SWARM_ROOT=/opt/swarm

ENTRYPOINT ["/opt/swarm/worker/entrypoint.sh"]
