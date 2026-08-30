#!/usr/bin/env bash
set -Eeuo pipefail

fail() {
  printf 'run_dotnet.sh: error: %s\n' "$1" >&2
  exit 2
}

usage() {
  printf 'Usage: %s <project-path> [restore|build|test|all]\n' "$0" >&2
  exit 2
}

[[ $# -ge 1 && $# -le 2 ]] || usage
[[ -n "${SANDBOX_ROOT:-}" ]] || fail 'SANDBOX_ROOT is required'
[[ "${SANDBOX_EXECUTION_MODE:-deny}" == 'isolated' ]] || fail 'SANDBOX_EXECUTION_MODE=isolated is required; host execution is denied by default'
[[ "${MIGRATIONHARNESS_ISOLATED_SANDBOX:-0}" == '1' ]] || fail 'MIGRATIONHARNESS_ISOLATED_SANDBOX=1 must be set by the isolated sandbox runtime'

PYTHON_BIN="${PYTHON_BIN:-python3}"
TIMEOUT_SECONDS="${SANDBOX_TIMEOUT_SECONDS:-300}"
PROJECT_INPUT="$1"
ACTION="${2:-test}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"

command -v "$PYTHON_BIN" >/dev/null 2>&1 || fail "Python executable not found: $PYTHON_BIN"
command -v timeout >/dev/null 2>&1 || fail 'the timeout command is required'
command -v dotnet >/dev/null 2>&1 || fail 'dotnet SDK is not installed in the isolated sandbox'
[[ "$TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]] || fail 'SANDBOX_TIMEOUT_SECONDS must be a positive integer'
(( TIMEOUT_SECONDS <= 3600 )) || fail 'SANDBOX_TIMEOUT_SECONDS cannot exceed 3600'

case "$ACTION" in
  restore|build|test|all) ;;
  *) fail "unsupported action: $ACTION" ;;
esac

PROJECT_PATH="$($PYTHON_BIN "$SCRIPT_DIR/path_guard.py" \
  --root "$SANDBOX_ROOT" \
  --path "$PROJECT_INPUT" \
  --must-exist \
  --allow-root)" || exit $?

SANDBOX_HOME="$($PYTHON_BIN "$SCRIPT_DIR/path_guard.py" \
  --root "$SANDBOX_ROOT" \
  --path '.migrationharness/dotnet-home')" || exit $?
NUGET_PACKAGES_PATH="$($PYTHON_BIN "$SCRIPT_DIR/path_guard.py" \
  --root "$SANDBOX_ROOT" \
  --path '.migrationharness/nuget-packages')" || exit $?
mkdir -p -- "$SANDBOX_HOME" "$NUGET_PACKAGES_PATH"

export DOTNET_CLI_HOME="$SANDBOX_HOME"
export DOTNET_CLI_TELEMETRY_OPTOUT=1
export DOTNET_NOLOGO=1
export NUGET_PACKAGES="$NUGET_PACKAGES_PATH"

run_dotnet() {
  timeout --signal=TERM --kill-after=5s "${TIMEOUT_SECONDS}s" dotnet "$@"
}

restore_project() {
  run_dotnet restore "$PROJECT_PATH" --nologo
}

build_project() {
  run_dotnet build "$PROJECT_PATH" --no-restore --nologo --verbosity minimal
}

test_project() {
  run_dotnet test "$PROJECT_PATH" --no-restore --nologo --verbosity minimal
}

case "$ACTION" in
  restore) restore_project ;;
  build) build_project ;;
  test) test_project ;;
  all)
    restore_project
    build_project
    test_project
    ;;
esac
