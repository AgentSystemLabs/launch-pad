#!/usr/bin/env bash
# Headless cursor-agent loop — obeys the operator control plane.
#
# Each iteration:
#   1. GET /control      → if paused, sleep PAUSE_POLL_SEC and re-check
#   2. GET /control      → if state != running, sleep IDLE_POLL_SEC (agents sleep
#                          until the operator clicks Run — no Cursor spend)
#   3. GET /mission/active → if no active mission, sleep IDLE_POLL_SEC
#   4. heartbeat + WAL working → run cursor-agent (mission injected) → WAL done
#
# stdout from cursor-agent is streamed to the operator UI in small batches.
set -uo pipefail

SWARM_ROOT="/opt/swarm"
PROMPT_FILE="${SWARM_ROOT}/prompt.md"
LOOPS_DIR="${SWARM_ROOT}/loops"
WORKSPACE="${WORKSPACE:-/workspace/target}"
LOOP_IDLE_SEC="${LOOP_IDLE_SEC:-15}"     # pause between completed tasks
IDLE_POLL_SEC="${IDLE_POLL_SEC:-45}"     # poll cadence when no mission/not running
PAUSE_POLL_SEC="${PAUSE_POLL_SEC:-15}"   # poll cadence while paused
MODEL="${CURSOR_MODEL:-}"

export AGENT_ID="${AGENT_ID:-${HOSTNAME}}"
export WAL_URL="${WAL_URL:?WAL_URL required}"
export GITHUB_REPO="${GITHUB_REPO:-}"
export PATH="${HOME}/.local/bin:${PATH}"
WAL_URL="${WAL_URL%/}"

if ! command -v cursor-agent >/dev/null 2>&1; then
  echo "[swarm] error: cursor-agent not on PATH" >&2
  exit 1
fi
if [[ -z "${CURSOR_API_KEY:-}" ]] && ! cursor-agent status >/dev/null 2>&1; then
  echo "[swarm] error: set CURSOR_API_KEY secret or bake cursor login" >&2
  exit 1
fi

# ── WAL / control-plane helpers ─────────────────────────────────────────────

wal_post() { # event payload (json object string)
  curl -sfS -m 5 -X POST -H "content-type: application/json" -d "$1" \
    "${WAL_URL}/wal/append" >/dev/null 2>&1 || true
}

heartbeat() { # status summary loop
  local payload
  payload="$(jq -nc --arg a "${AGENT_ID}" --arg s "$1" --arg sum "$2" --arg l "$3" \
    --argjson idx "${REPLICA_INDEX:-null}" \
    '{agent:$a, status:$s, summary:$sum, loop:$l, replicaIndex:$idx}')"
  curl -sfS -m 5 -X POST -H "content-type: application/json" -d "${payload}" \
    "${WAL_URL}/agents/heartbeat" >/dev/null 2>&1 || true
}

# Echo the control JSON once; callers parse with jq.
fetch_control() { curl -sfS -m 5 "${WAL_URL}/control" 2>/dev/null || echo '{}'; }
# Echo the active mission body, or empty string when no mission is armed.
fetch_mission() {
  curl -sfS -m 5 "${WAL_URL}/mission/active" 2>/dev/null \
    | jq -r '.mission.body // empty' 2>/dev/null || true
}

# ── stdout streaming ────────────────────────────────────────────────────────
# Reads cursor-agent output on stdin, echoes to container logs, and POSTs lines
# to /agents/:id/stdout in small batches (count- or time-triggered). Runs in the
# pipeline as a single serial consumer, so there is no curl process pile-up.

SWARM_OUTBUF_FILE="$(mktemp)"
flush_stdout() {
  [[ -s "${SWARM_OUTBUF_FILE}" ]] || return 0
  local json
  json="$(jq -R . <"${SWARM_OUTBUF_FILE}" | jq -sc '{lines: .}')"
  : >"${SWARM_OUTBUF_FILE}"
  curl -sfS -m 5 -X POST -H "content-type: application/json" -d "${json}" \
    "${WAL_URL}/agents/${AGENT_ID}/stdout" >/dev/null 2>&1 || true
}

stream_stdout() {
  local line rc count=0
  : >"${SWARM_OUTBUF_FILE}"
  while true; do
    IFS= read -r -t 2 line; rc=$?
    if [[ ${rc} -eq 0 ]]; then
      printf '%s\n' "${line}"
      printf '%s\n' "${line}" >>"${SWARM_OUTBUF_FILE}"
      count=$((count + 1))
      if [[ ${count} -ge 20 ]]; then flush_stdout; count=0; fi
    elif [[ ${rc} -gt 128 ]]; then
      flush_stdout; count=0          # idle timeout → push partial batch
    else
      if [[ -n "${line:-}" ]]; then  # trailing line with no newline at EOF
        printf '%s\n' "${line}"
        printf '%s\n' "${line}" >>"${SWARM_OUTBUF_FILE}"
      fi
      flush_stdout; break            # EOF
    fi
  done
}

render_prompt() { # loop_file mission_body
  local loop_file="$1" mission="$2" base
  base="$(cat "${PROMPT_FILE}")"
  base="${base//\{\{SWARM_GOAL\}\}/${mission}}"
  base="${base//\{\{WAL_URL\}\}/${WAL_URL}}"
  base="${base//\{\{TARGET_BRANCH\}\}/${TARGET_BRANCH:-main}}"
  cat <<EOF
${base}

---

## Active mission (set by the operator — this is your goal)

${mission}

---

## Active loop (follow exactly)

$(cat "${loop_file}")

---

## Runtime

- Agent id: ${AGENT_ID}
- Workspace: ${WORKSPACE}
- GitHub repo: ${GITHUB_REPO}
- MCP: use swarm MCP tools for WAL, locks, stdout, and GitHub
- Heartbeat with \`agent_status\` and stream notable steps with \`stdout_append\`
- Never ask humans for input; keep working until the operator pauses the swarm
EOF
}

pick_loop() {
  local idx n name
  idx="${AGENT_ID##*_}"
  if [[ "${idx}" =~ ^[0-9]+$ ]]; then n=$((idx % 11)); else n=$((RANDOM % 11)); fi
  case "${n}" in
    0) name="idea.md" ;;
    1) name="bug-report.md" ;;
    2) name="ux-review.md" ;;
    3) name="security-review.md" ;;
    4) name="pr-review.md" ;;
    5) name="create-pr.md" ;;
    6) name="fix-conflicts.md" ;;
    7) name="merge-pr.md" ;;
    8) name="self-review.md" ;;
    9) name="label-issues.md" ;;
    *) name="run-and-verify.md" ;;
  esac
  echo "${LOOPS_DIR}/${name}"
}

write_mcp_config() {
  local cfg="${HOME}/.cursor/mcp.json"
  mkdir -p "${HOME}/.cursor"
  cp /opt/swarm/.cursor/hooks.json "${HOME}/.cursor/hooks.json" 2>/dev/null || true
  cat >"${cfg}" <<EOF
{
  "mcpServers": {
    "swarm": {
      "command": "node",
      "args": ["/opt/swarm-mcp/server.mjs"],
      "env": {
        "WAL_URL": "${WAL_URL}",
        "GITHUB_TOKEN": "${GITHUB_TOKEN:-}",
        "GITHUB_REPO": "${GITHUB_REPO}",
        "AGENT_ID": "${AGENT_ID}",
        "TRACKING_ISSUE": "${TRACKING_ISSUE:-}"
      }
    }
  }
}
EOF
}

write_mcp_config

# Replica index for the grid (engineer_N → N).
REPLICA_INDEX="${AGENT_ID##*_}"
[[ "${REPLICA_INDEX}" =~ ^[0-9]+$ ]] || REPLICA_INDEX=null

iteration=0
while true; do
  control="$(fetch_control)"
  paused="$(echo "${control}" | jq -r '.paused // false' 2>/dev/null || echo false)"
  state="$(echo "${control}" | jq -r '.state // "idle"' 2>/dev/null || echo idle)"

  if [[ "${paused}" == "true" ]]; then
    heartbeat "paused" "Swarm paused by operator" ""
    sleep "${PAUSE_POLL_SEC}"
    continue
  fi

  if [[ "${state}" != "running" ]]; then
    heartbeat "sleeping" "Idle — waiting for operator to Run" ""
    sleep "${IDLE_POLL_SEC}"
    continue
  fi

  mission="$(fetch_mission)"
  if [[ -z "${mission}" ]]; then
    # Fallback to static env goal only if explicitly provided; otherwise sleep.
    if [[ -n "${SWARM_GOAL:-}" ]]; then
      mission="${SWARM_GOAL}"
    else
      heartbeat "sleeping" "No active mission — sleeping" ""
      sleep "${IDLE_POLL_SEC}"
      continue
    fi
  fi

  iteration=$((iteration + 1))
  loop_file="$(pick_loop)"
  loop_name="$(basename "${loop_file}" .md)"
  prompt="$(render_prompt "${loop_file}" "${mission}")"

  heartbeat "working" "Starting loop: ${loop_name}" "${loop_name}"
  wal_post "$(jq -nc --arg a "${AGENT_ID}" --arg l "${loop_name}" \
    '{agent:$a, event:"working", loop:$l, summary:("Starting loop: "+$l)}')"
  echo "[swarm] ${AGENT_ID} iter=${iteration} loop=${loop_name} started=$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  agent_args=(--print --trust --force --approve-mcps --workspace "${WORKSPACE}" --output-format text)
  [[ -n "${MODEL}" ]] && agent_args+=(--model "${MODEL}")

  # Run cursor-agent; stream combined stdout/stderr to logs + operator UI.
  cursor-agent "${agent_args[@]}" "${prompt}" 2>&1 | stream_stdout
  exit_code="${PIPESTATUS[0]}"

  echo "[swarm] ${AGENT_ID} iter=${iteration} loop=${loop_name} exit=${exit_code} finished=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  heartbeat "idle" "Finished loop: ${loop_name}" "${loop_name}"

  # Fallback `done` only when the agent crashed before posting its own report.
  if [[ "${exit_code}" -ne 0 ]]; then
    wal_post "$(jq -nc --arg a "${AGENT_ID}" --arg l "${loop_name}" --argjson c "${exit_code}" \
      '{agent:$a, event:"done", loop:$l, summary:"Loop failed", report:("cursor-agent exited "+($c|tostring)+". Re-read WAL before retrying overlapping work.")}')"
  fi

  sleep "${LOOP_IDLE_SEC}"
done
