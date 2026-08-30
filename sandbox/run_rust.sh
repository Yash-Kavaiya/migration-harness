#!/usr/bin/env bash
set -Eeuo pipefail

fail() {
  printf 'run_rust.sh: error: %s\n' "$1" >&2
  exit 2
}

usage() {
  printf 'Usage: %s <cargo-project-directory> [fmt|check|build|test|clippy|all]\n' "$0" >&2
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
command -v cargo >/dev/null 2>&1 || fail 'cargo is not installed in the isolated sandbox'
[[ "$TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]] || fail 'SANDBOX_TIMEOUT_SECONDS must be a positive integer'
(( TIMEOUT_SECONDS <= 3600 )) || fail 'SANDBOX_TIMEOUT_SECONDS cannot exceed 3600'

case "$ACTION" in
  fmt|check|build|test|clippy|all) ;;
  *) fail "unsupported action: $ACTION" ;;
esac

PROJECT_PATH="$($PYTHON_BIN "$SCRIPT_DIR/path_guard.py" \
  --root "$SANDBOX_ROOT" \
  --path "$PROJECT_INPUT" \
  --must-exist \
  --kind directory \
  --allow-root)" || exit $?
MANIFEST_PATH="$($PYTHON_BIN "$SCRIPT_DIR/path_guard.py" \
  --root "$SANDBOX_ROOT" \
  --path "$PROJECT_PATH/Cargo.toml" \
  --must-exist \
  --kind file)" || exit $?
CARGO_HOME_PATH="$($PYTHON_BIN "$SCRIPT_DIR/path_guard.py" \
  --root "$SANDBOX_ROOT" \
  --path '.migrationharness/cargo-home')" || exit $?
TARGET_PATH="$($PYTHON_BIN "$SCRIPT_DIR/path_guard.py" \
  --root "$SANDBOX_ROOT" \
  --path '.migrationharness/cargo-target')" || exit $?
mkdir -p -- "$CARGO_HOME_PATH" "$TARGET_PATH"

export CARGO_HOME="$CARGO_HOME_PATH"
export CARGO_TARGET_DIR="$TARGET_PATH"
export CARGO_TERM_COLOR=never

run_cargo() {
  timeout --signal=TERM --kill-after=5s "${TIMEOUT_SECONDS}s" cargo "$@"
}

format_project() {
  run_cargo fmt --manifest-path "$MANIFEST_PATH" -- --check
}

check_project() {
  run_cargo check --manifest-path "$MANIFEST_PATH" --locked
}

build_project() {
  run_cargo build --manifest-path "$MANIFEST_PATH" --locked
}

test_project() {
  run_cargo test --manifest-path "$MANIFEST_PATH" --locked
}

lint_project() {
  run_cargo clippy --manifest-path "$MANIFEST_PATH" --locked -- -D warnings
}

case "$ACTION" in
  fmt) format_project ;;
  check) check_project ;;
  build) build_project ;;
  test) test_project ;;
  clippy) lint_project ;;
  all)
    format_project
    check_project
    build_project
    test_project
    lint_project
    ;;
esac
