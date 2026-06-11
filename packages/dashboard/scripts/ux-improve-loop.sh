#!/usr/bin/env bash
# Run cursor-agent in headless mode on a loop to iteratively improve dashboard UX.
#
# Usage:
#   ./scripts/ux-improve-loop.sh              # infinite loop, 60s between runs
#   MAX_ITERATIONS=5 ./scripts/ux-improve-loop.sh
#   INTERVAL=120 ./scripts/ux-improve-loop.sh
#   MODEL=sonnet-4 ./scripts/ux-improve-loop.sh
#
# Requires: cursor-agent on PATH (cursor-agent login), bun, playwright browsers for e2e.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DASHBOARD_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${DASHBOARD_DIR}/../.." && pwd)"

CURSOR_AGENT="${CURSOR_AGENT:-cursor-agent}"
INTERVAL="${INTERVAL:-60}"
MAX_ITERATIONS="${MAX_ITERATIONS:-0}" # 0 = run until Ctrl+C
MODEL="${MODEL:-}"
LOG_DIR="${LOG_DIR:-${DASHBOARD_DIR}/.ux-improve-loop/logs}"

PROMPT="${PROMPT:-load up the dashboard and continue to interact with it and improve the user experience each time.  focus on one thing to improve and make it better. use playwright to interact with the UI to verify it.}"

FULL_PROMPT="$(cat <<EOF
${PROMPT}

Context for this repo:
- Dashboard package: packages/dashboard (Bun + orbital-js SSR, daisyUI)
- Start dev server: cd packages/dashboard && bun run dev  → http://127.0.0.1:4000
- E2E tests (fake CLI, no AWS): cd packages/dashboard && bun run test:e2e
- Read packages/dashboard/README.md before changing behavior
- Pick ONE UX improvement per iteration; run Playwright to verify; keep diffs focused
EOF
)"

mkdir -p "${LOG_DIR}"

if ! command -v "${CURSOR_AGENT}" >/dev/null 2>&1; then
  echo "error: ${CURSOR_AGENT} not found on PATH" >&2
  echo "Install: https://cursor.com/docs/cli" >&2
  exit 1
fi

if ! "${CURSOR_AGENT}" status >/dev/null 2>&1; then
  echo "error: ${CURSOR_AGENT} is not authenticated — run: ${CURSOR_AGENT} login" >&2
  exit 1
fi

stop_requested=0
trap 'stop_requested=1; echo; echo "Stopping after current iteration…"' INT TERM

run_iteration() {
  local iteration="$1"
  local log_file="${LOG_DIR}/iteration-$(printf '%04d' "${iteration}").log"
  local started_at exit_code
  started_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

  echo "────────────────────────────────────────────────────────"
  echo "Iteration ${iteration} — ${started_at}"
  echo "Log: ${log_file}"
  echo "────────────────────────────────────────────────────────"

  local -a agent_args=(
    --print
    --trust
    --force
    --approve-mcps
    --workspace "${REPO_ROOT}"
    --output-format text
  )

  if [[ -n "${MODEL}" ]]; then
    agent_args+=(--model "${MODEL}")
  fi

  # Continue the same agent session after the first run so work accumulates.
  if (( iteration > 1 )); then
    agent_args+=(--continue)
  fi

  {
    echo "=== iteration ${iteration} started ${started_at} ==="
    echo "=== prompt ==="
    echo "${FULL_PROMPT}"
    echo "=== agent output ==="
    "${CURSOR_AGENT}" "${agent_args[@]}" "${FULL_PROMPT}"
  } 2>&1 | tee "${log_file}"

  exit_code="${PIPESTATUS[0]}"
  if (( exit_code != 0 )); then
    echo "warning: iteration ${iteration} exited ${exit_code}" >&2
  fi
}

echo "Launch Pad dashboard UX improve loop"
echo "  repo:        ${REPO_ROOT}"
echo "  dashboard:   ${DASHBOARD_DIR}"
echo "  agent:       ${CURSOR_AGENT}"
echo "  interval:    ${INTERVAL}s"
echo "  max runs:    $([[ "${MAX_ITERATIONS}" == "0" ]] && echo "∞ (Ctrl+C to stop)" || echo "${MAX_ITERATIONS}")"
echo "  logs:        ${LOG_DIR}"
echo

iteration=1
while [[ "${stop_requested}" -eq 0 ]]; do
  run_iteration "${iteration}" || true

  if [[ "${MAX_ITERATIONS}" != "0" && "${iteration}" -ge "${MAX_ITERATIONS}" ]]; then
    echo "Reached MAX_ITERATIONS=${MAX_ITERATIONS}. Done."
    break
  fi

  if [[ "${stop_requested}" -ne 0 ]]; then
    break
  fi

  echo "Sleeping ${INTERVAL}s before next iteration… (Ctrl+C to stop)"
  sleep "${INTERVAL}" &
  wait $! 2>/dev/null || true

  iteration=$((iteration + 1))
done

echo "Loop stopped after ${iteration} iteration(s)."
