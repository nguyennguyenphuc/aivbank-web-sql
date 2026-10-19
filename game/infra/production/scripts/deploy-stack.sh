#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
# shellcheck disable=SC1091
. "$SCRIPT_DIR/candy-common.sh"

load_release_context
resolve_compose_command
assert_rootless_connection

: "${CANDY_RELEASE_SHA:?CANDY_RELEASE_SHA must be the full Git SHA selected for deployment}"
case "$CANDY_RELEASE_SHA" in
  *[!0-9a-f]*) die "CANDY_RELEASE_SHA is not a lowercase Git SHA" ;;
esac
[ "${#CANDY_RELEASE_SHA}" -eq 40 ] || die "CANDY_RELEASE_SHA must contain exactly 40 hex characters"
[ -z "${CANDY_RUN_SEED:-}" ] || \
  die "CANDY_RUN_SEED is intentionally unsupported: db:seed creates demo accounts and is restricted-preview-only"

require_command git
actual_sha="$(git -C "$CANDY_RELEASE_DIR" rev-parse HEAD)"
[ "$actual_sha" = "$CANDY_RELEASE_SHA" ] || \
  die "release HEAD $actual_sha does not match CANDY_RELEASE_SHA"
[ -z "$(git -C "$CANDY_RELEASE_DIR" status --porcelain)" ] || \
  die "release worktree is dirty; refusing to deploy"

validate_compose_config
assert_release_config_identity "$CANDY_RELEASE_SHA"
note "building immutable release $CANDY_RELEASE_SHA for project $CANDY_PROJECT_NAME"
compose build --pull
compose up --detach postgres redis
wait_for_service_health postgres
wait_for_service_health redis

note "bootstrapping the non-superuser owner of the dedicated application database"
"$SCRIPT_DIR/bootstrap-db-role.sh"
note "running forward-only database migrations"
compose --profile operations run --rm --no-deps ops
"$SCRIPT_DIR/bootstrap-db-role.sh"

compose up --detach api web cloudflared
wait_for_service_health api
wait_for_service_health web
wait_for_service_running cloudflared
note "release $CANDY_RELEASE_SHA reconciled; run verify-stack.sh before accepting it"
