#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
# shellcheck disable=SC1091
. "$SCRIPT_DIR/candy-common.sh"

load_release_context
resolve_compose_command
assert_rootless_connection
require_command curl
validate_compose_config

for service in postgres redis api web; do
  wait_for_service_health "$service" 30 2
done
wait_for_service_running cloudflared 30 2

container_count=0
while IFS= read -r container_id; do
  [ -n "$container_id" ] || continue
  container_count=$((container_count + 1))
  published="$(podman port "$container_id" 2>/dev/null || true)"
  [ -z "$published" ] || die "container $container_id publishes a host port: $published"
done < <(project_container_ids)
[ "$container_count" -ge 5 ] || die "expected at least five candy containers; found $container_count"

web_id="$(service_container_id web)"
[ -n "$web_id" ] || die "web container is not running"
podman exec "$web_id" wget -qO- http://127.0.0.1:8080/api/health | grep -Fq '"ok":true'
podman exec "$web_id" wget -qO- http://127.0.0.1:8080/api/ready | grep -Fq '"ok":true'

: "${CANDY_PUBLIC_ORIGIN:?CANDY_PUBLIC_ORIGIN must be the expected HTTPS origin}"
[ "$CANDY_PUBLIC_ORIGIN" = "https://candy.longh.work" ] || \
  die "CANDY_PUBLIC_ORIGIN must be exactly https://candy.longh.work"

curl_flags=(--fail --silent --show-error --proto '=https' --tlsv1.2 --connect-timeout 10 --max-time 30)
root_html="$(mktemp "${TMPDIR:-/tmp}/candy-root.XXXXXX")"
trap 'rm -f "$root_html"' EXIT
curl "${curl_flags[@]}" "$CANDY_PUBLIC_ORIGIN/" >"$root_html"
grep -qi '<!doctype html' "$root_html" || die "public root did not return the application HTML"
asset_path="$(grep -Eo 'src="/assets/[^"]+\.js"' "$root_html" | head -n 1 | cut -d '"' -f 2)"
[ -n "$asset_path" ] || die "public root did not reference a hashed JavaScript asset"
curl "${curl_flags[@]}" "$CANDY_PUBLIC_ORIGIN$asset_path" >/dev/null
curl "${curl_flags[@]}" "$CANDY_PUBLIC_ORIGIN/api/health" | grep -Fq '"ok":true'
curl "${curl_flags[@]}" "$CANDY_PUBLIC_ORIGIN/api/ready" | grep -Fq '"ok":true'
curl "${curl_flags[@]}" "$CANDY_PUBLIC_ORIGIN/sw.js" >/dev/null
curl "${curl_flags[@]}" "$CANDY_PUBLIC_ORIGIN/manifest.webmanifest" >/dev/null
curl "${curl_flags[@]}" "$CANDY_PUBLIC_ORIGIN/__candy_spa_verification__" | grep -qi '<!doctype html' || \
  die "SPA fallback verification failed"

printf 'candy verification passed: containers=%s published_ports=0 origin=%s\n' \
  "$container_count" "$CANDY_PUBLIC_ORIGIN"
