#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
# shellcheck disable=SC1091
. "$SCRIPT_DIR/candy-common.sh"

load_release_context
resolve_compose_command
assert_rootless_connection
validate_compose_config

note "reconciling Compose project $CANDY_PROJECT_NAME"
compose up --detach
wait_for_service_health postgres
wait_for_service_health redis
wait_for_service_health api
wait_for_service_health web
wait_for_service_running cloudflared
note "Compose project $CANDY_PROJECT_NAME is healthy"
