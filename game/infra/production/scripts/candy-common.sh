#!/bin/bash

set -euo pipefail

CANDY_PROJECT_NAME="candy"

die() {
  printf 'candy: %s\n' "$*" >&2
  exit 1
}

note() {
  printf 'candy: %s\n' "$*" >&2
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

require_absolute_path() {
  local value="$1"
  local label="$2"
  case "$value" in
    /*) ;;
    *) die "$label must be an absolute path" ;;
  esac
  [ "$value" != "/" ] || die "$label must not be /"
}

canonical_directory() {
  (cd "$1" 2>/dev/null && pwd -P) || return 1
}

file_mode() {
  if stat -f '%Lp' "$1" >/dev/null 2>&1; then
    stat -f '%Lp' "$1"
  else
    stat -c '%a' "$1"
  fi
}

require_private_file() {
  local path="$1"
  local mode
  [ -f "$path" ] || die "required file does not exist: $path"
  [ ! -L "$path" ] || die "secret-bearing file must not be a symlink: $path"
  mode="$(file_mode "$path")"
  case "$mode" in
    *00) ;;
    *) die "$path must not be readable or writable by group/other (current mode $mode)" ;;
  esac
}

load_release_context() {
  local expected_compose_file
  : "${CANDY_RELEASE_DIR:?CANDY_RELEASE_DIR must be an absolute release/current directory}"
  : "${CANDY_ENV_FILE:?CANDY_ENV_FILE must be the absolute production env path}"
  require_absolute_path "$CANDY_RELEASE_DIR" CANDY_RELEASE_DIR
  require_absolute_path "$CANDY_ENV_FILE" CANDY_ENV_FILE
  [ -d "$CANDY_RELEASE_DIR" ] || die "release directory does not exist: $CANDY_RELEASE_DIR"
  CANDY_RELEASE_DIR="$(canonical_directory "$CANDY_RELEASE_DIR")"
  expected_compose_file="$CANDY_RELEASE_DIR/infra/production/compose.yml"
  CANDY_COMPOSE_FILE="${CANDY_COMPOSE_FILE:-$expected_compose_file}"
  require_absolute_path "$CANDY_COMPOSE_FILE" CANDY_COMPOSE_FILE
  [ "$CANDY_COMPOSE_FILE" = "$expected_compose_file" ] || \
    die "CANDY_COMPOSE_FILE must be the production Compose file inside the selected release"
  [ -f "$CANDY_COMPOSE_FILE" ] || die "Compose file does not exist: $CANDY_COMPOSE_FILE"
  [ ! -L "$CANDY_COMPOSE_FILE" ] || die "Compose file must not be a symlink"
  require_private_file "$CANDY_ENV_FILE"
  export CANDY_PROJECT_NAME CANDY_RELEASE_DIR CANDY_COMPOSE_FILE CANDY_ENV_FILE
}

resolve_compose_command() {
  require_command podman
  if command -v podman-compose >/dev/null 2>&1; then
    CANDY_COMPOSE_BIN="$(command -v podman-compose)"
  else
    die "podman-compose is required"
  fi
  export CANDY_COMPOSE_BIN
}

compose() {
  "$CANDY_COMPOSE_BIN" \
    --project-name "$CANDY_PROJECT_NAME" \
    --file "$CANDY_COMPOSE_FILE" \
    --env-file "$CANDY_ENV_FILE" \
    "$@"
}

assert_rootless_connection() {
  local default_connection
  local rootless
  default_connection="$(podman system connection list --format '{{.Name}} {{.Default}}' 2>/dev/null | \
    awk '$2 == "true" { print $1 }')"
  [ "$default_connection" = "podman-machine-default" ] || \
    die "default Podman connection must be podman-machine-default"
  rootless="$(podman info --format '{{.Host.Security.Rootless}}' 2>/dev/null)" || \
    die "Podman rootless connection is unavailable"
  [ "$rootless" = "true" ] || die "refusing to operate on a non-rootless Podman connection"
}

validate_compose_config() {
  local rendered
  rendered="$(mktemp "${TMPDIR:-/tmp}/candy-compose.XXXXXX")"
  if ! compose --profile operations config >"$rendered"; then
    rm -f "$rendered"
    die "Compose config validation failed"
  fi
  if grep -Eq '^[[:space:]]+ports:|^[[:space:]]+published:' "$rendered"; then
    rm -f "$rendered"
    die "Compose config contains a host port publication"
  fi
  rm -f "$rendered"
}

assert_release_config_identity() {
  local release_sha="$1"
  local rendered
  local image
  rendered="$(mktemp "${TMPDIR:-/tmp}/candy-release.XXXXXX")"
  if ! compose --profile operations config >"$rendered"; then
    rm -f "$rendered"
    die "Compose config validation failed"
  fi
  for image in web api ops; do
    if ! grep -Fq "image: localhost/match3-h5-$image:$release_sha" "$rendered"; then
      rm -f "$rendered"
      die "Compose $image image tag does not match CANDY_RELEASE_SHA"
    fi
  done
  if ! grep -Eq "RELEASE_SHA(: |[=])$release_sha" "$rendered"; then
    rm -f "$rendered"
    die "Compose build revision does not match CANDY_RELEASE_SHA"
  fi
  rm -f "$rendered"
}

wait_for_service_health() {
  local service="$1"
  local attempts="${2:-60}"
  local interval="${3:-2}"
  local container_id=""
  local attempt=1
  while [ "$attempt" -le "$attempts" ]; do
    container_id="$(service_container_id "$service")"
    if [ -n "$container_id" ] && \
      [ "$(podman inspect --format '{{.State.Status}}' "$container_id" 2>/dev/null)" = "running" ] && \
      podman healthcheck run "$container_id" >/dev/null 2>&1; then
      return 0
    fi
    sleep "$interval"
    attempt=$((attempt + 1))
  done
  [ -z "$container_id" ] || podman logs --tail 80 "$container_id" >&2 || true
  die "service did not become healthy: $service"
}

wait_for_service_running() {
  local service="$1"
  local attempts="${2:-60}"
  local interval="${3:-2}"
  local container_id=""
  local attempt=1
  while [ "$attempt" -le "$attempts" ]; do
    container_id="$(service_container_id "$service")"
    if [ -n "$container_id" ] && \
      [ "$(podman inspect --format '{{.State.Status}}' "$container_id" 2>/dev/null)" = "running" ]; then
      return 0
    fi
    sleep "$interval"
    attempt=$((attempt + 1))
  done
  [ -z "$container_id" ] || podman logs --tail 80 "$container_id" >&2 || true
  die "service is not running: $service"
}

project_container_ids() {
  compose ps -q
}

service_container_id() {
  local service="$1"
  podman ps --all --quiet \
    --filter "label=io.podman.compose.project=$CANDY_PROJECT_NAME" \
    --filter "label=io.podman.compose.service=$service" | head -n 1
}
