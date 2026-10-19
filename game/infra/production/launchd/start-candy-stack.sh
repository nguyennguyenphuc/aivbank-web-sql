#!/bin/bash

set -euo pipefail
umask 077

PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin${PATH:+:$PATH}"
export PATH
: "${CANDY_RELEASE_DIR:?CANDY_RELEASE_DIR is required}"
: "${CANDY_ENV_FILE:?CANDY_ENV_FILE is required}"

retries="${CANDY_PODMAN_RETRIES:-60}"
interval="${CANDY_PODMAN_RETRY_INTERVAL:-2}"
case "$retries:$interval" in
  *[!0-9:]*) printf 'candy launch: retry values must be positive integers\n' >&2; exit 1 ;;
esac
[ "$retries" -ge 1 ] && [ "$retries" -le 180 ] || exit 1
[ "$interval" -ge 1 ] && [ "$interval" -le 10 ] || exit 1

machine_state="$(podman machine inspect podman-machine-default --format '{{.State}}' 2>/dev/null || true)"
if [ "$machine_state" != "running" ]; then
  printf 'candy launch: starting podman-machine-default\n' >&2
  podman machine start podman-machine-default >/dev/null || \
    printf 'candy launch: start command returned non-zero; waiting for the bounded readiness check\n' >&2
fi

attempt=1
while ! podman --connection podman-machine-default info >/dev/null 2>&1; do
  if [ "$attempt" -ge "$retries" ]; then
    printf 'candy launch: Podman socket unavailable after %s attempts\n' "$retries" >&2
    exit 1
  fi
  sleep "$interval"
  attempt=$((attempt + 1))
done

default_connection="$(podman system connection list --format '{{.Name}} {{.Default}}' | awk '$2 == "true" { print $1 }')"
[ "$default_connection" = "podman-machine-default" ] || {
  printf 'candy launch: podman-machine-default is not the default connection\n' >&2
  exit 1
}
rootless="$(podman info --format '{{.Host.Security.Rootless}}')"
[ "$rootless" = "true" ] || { printf 'candy launch: default connection is not rootless\n' >&2; exit 1; }

reconcile="$CANDY_RELEASE_DIR/infra/production/scripts/reconcile-stack.sh"
[ -x "$reconcile" ] || { printf 'candy launch: missing executable %s\n' "$reconcile" >&2; exit 1; }
exec "$reconcile"
