#!/bin/bash
# shellcheck disable=SC2016

set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
# shellcheck disable=SC1091
. "$SCRIPT_DIR/candy-common.sh"

load_release_context
resolve_compose_command
assert_rootless_connection
: "${CANDY_BACKUP_DIR:?CANDY_BACKUP_DIR must be an absolute host backup directory}"
require_absolute_path "$CANDY_BACKUP_DIR" CANDY_BACKUP_DIR
[ -d "$CANDY_BACKUP_DIR" ] || die "backup directory does not exist: $CANDY_BACKUP_DIR"
[ ! -L "$CANDY_BACKUP_DIR" ] || die "backup directory must not be a symlink"
CANDY_BACKUP_DIR="$(canonical_directory "$CANDY_BACKUP_DIR")"
[ -w "$CANDY_BACKUP_DIR" ] || die "backup directory is not writable: $CANDY_BACKUP_DIR"
case "$CANDY_BACKUP_DIR/" in
  "$CANDY_RELEASE_DIR"/*) die "backup directory must be outside the release directory" ;;
esac

wait_for_service_health postgres 30 2
timestamp="$(date -u '+%Y%m%dT%H%M%SZ')-$$"
final_dump="$CANDY_BACKUP_DIR/match3-h5-$timestamp.dump"
[ ! -e "$final_dump" ] && [ ! -e "$final_dump.sha256" ] || die "refusing to overwrite an existing backup"
tmp_dump="$(mktemp "$CANDY_BACKUP_DIR/.match3-h5-$timestamp.XXXXXX")"
cleanup() {
  rm -f "$tmp_dump"
}
trap cleanup EXIT
trap 'cleanup; exit 1' HUP INT TERM

compose exec -T postgres sh -eu -c \
  'pg_dump --format=custom --no-owner --no-privileges --username "$POSTGRES_USER" --dbname "$POSTGRES_DB"' \
  >"$tmp_dump"
[ -s "$tmp_dump" ] || die "pg_dump produced an empty artifact"
compose exec -T postgres pg_restore --list <"$tmp_dump" >/dev/null
chmod 600 "$tmp_dump"
if command -v shasum >/dev/null 2>&1; then
  checksum="$(shasum -a 256 "$tmp_dump" | awk '{print $1}')"
elif command -v sha256sum >/dev/null 2>&1; then
  checksum="$(sha256sum "$tmp_dump" | awk '{print $1}')"
else
  die "shasum or sha256sum is required"
fi
mv "$tmp_dump" "$final_dump"
trap - EXIT HUP INT TERM
printf '%s  %s\n' "$checksum" "$(basename "$final_dump")" >"$final_dump.sha256"
chmod 600 "$final_dump.sha256"
printf 'backup=%s\nsha256=%s\n' "$final_dump" "$checksum"
