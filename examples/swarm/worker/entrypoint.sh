#!/usr/bin/env bash
set -euo pipefail

# Install cursor-agent (https://cursor.com/docs/cli)
if ! command -v cursor-agent >/dev/null 2>&1; then
  curl -fsSL https://cursor.com/install | bash
  export PATH="${HOME}/.local/bin:${PATH}"
fi

mkdir -p "${HOME}/.ssh" "${WORKSPACE}"
chmod 700 "${HOME}/.ssh"

if [[ -n "${GIT_SSH_KEY:-}" ]]; then
  printf '%s\n' "${GIT_SSH_KEY}" > "${HOME}/.ssh/id_ed25519"
  chmod 600 "${HOME}/.ssh/id_ed25519"
  ssh-keyscan github.com >> "${HOME}/.ssh/known_hosts" 2>/dev/null || true
fi

export GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -o StrictHostKeyChecking=accept-new}"

if [[ ! -d "${WORKSPACE}/.git" ]]; then
  echo "[swarm] cloning ${TARGET_REPO} → ${WORKSPACE}"
  git clone --depth 1 --branch "${TARGET_BRANCH:-main}" "${TARGET_REPO}" "${WORKSPACE}"
fi

cd "${WORKSPACE}"
git fetch origin "${TARGET_BRANCH:-main}" || true
git checkout "${TARGET_BRANCH:-main}" || true
git pull --rebase origin "${TARGET_BRANCH:-main}" || true

export AGENT_ID="${AGENT_ID:-${HOSTNAME}}"
export WAL_URL="${WAL_URL%/}"
export GITHUB_REPO="${GITHUB_REPO:-}"
export TRACKING_ISSUE="${TRACKING_ISSUE:-}"
export CURSOR_API_KEY="${CURSOR_API_KEY:-}"
export GH_TOKEN="${GITHUB_TOKEN:-}"
export GITHUB_TOKEN="${GITHUB_TOKEN:-}"

mkdir -p "${HOME}/.cursor"
cp /opt/swarm/.cursor/hooks.json "${HOME}/.cursor/hooks.json"

if [[ -n "${CURSOR_API_KEY}" ]]; then
  export CURSOR_API_KEY
fi

# Boot jitter: spread agents over ~5 minutes so they don't thundering-herd on start.
JITTER_MAX="${BOOT_JITTER_MAX_SEC:-300}"
idx="${AGENT_ID##*_}"
if [[ "${idx}" =~ ^[0-9]+$ ]]; then
  spread=$(( (idx * JITTER_MAX) / 100 ))
  noise=$((RANDOM % 30))
  boot_delay=$((spread + noise))
else
  boot_delay=$((RANDOM % JITTER_MAX))
fi
echo "[swarm] ${AGENT_ID} boot jitter: sleeping ${boot_delay}s (max ${JITTER_MAX}s)"

# Register in the operator grid immediately (status sleeping) so the agent shows
# up while it waits out boot jitter.
replica_index="${AGENT_ID##*_}"
[[ "${replica_index}" =~ ^[0-9]+$ ]] || replica_index=null
curl -sfS -m 5 -X POST -H "content-type: application/json" \
  -d "$(jq -nc --arg a "${AGENT_ID}" --argjson idx "${replica_index}" \
    '{agent:$a, status:"sleeping", summary:"Booting (jitter)", replicaIndex:$idx}')" \
  "${WAL_URL}/agents/heartbeat" >/dev/null 2>&1 || true

sleep "${boot_delay}"

curl -sfS -m 5 -X POST -H "content-type: application/json" \
  -d "$(jq -nc --arg a "${AGENT_ID}" --argjson d "${boot_delay}" \
    '{agent:$a, event:"boot", summary:("Online after boot jitter"), report:("Waited "+($d|tostring)+"s before first task.")}')" \
  "${WAL_URL}/wal/append" >/dev/null 2>&1 || true

exec /opt/swarm/worker/run-loop.sh
