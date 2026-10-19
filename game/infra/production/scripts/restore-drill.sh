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
: "${CANDY_BACKUP_FILE:?CANDY_BACKUP_FILE must be the absolute custom-format dump to drill}"
require_absolute_path "$CANDY_BACKUP_DIR" CANDY_BACKUP_DIR
require_absolute_path "$CANDY_BACKUP_FILE" CANDY_BACKUP_FILE
[ -d "$CANDY_BACKUP_DIR" ] || die "backup directory does not exist"
[ -f "$CANDY_BACKUP_FILE" ] || die "backup file does not exist"
[ ! -L "$CANDY_BACKUP_FILE" ] || die "backup file must not be a symlink"
backup_dir="$(canonical_directory "$CANDY_BACKUP_DIR")"
backup_parent="$(canonical_directory "$(dirname "$CANDY_BACKUP_FILE")")"
[ "$backup_dir" = "$backup_parent" ] || die "backup file must be directly inside CANDY_BACKUP_DIR"
[ -s "$CANDY_BACKUP_FILE" ] || die "backup file is empty"

wait_for_service_health postgres 30 2
compose exec -T postgres pg_restore --list <"$CANDY_BACKUP_FILE" >/dev/null

checksum_file="$CANDY_BACKUP_FILE.sha256"
if [ -f "$checksum_file" ]; then
  [ ! -L "$checksum_file" ] || die "checksum sidecar must not be a symlink"
  read -r expected_checksum expected_name extra <"$checksum_file"
  [ -z "${extra:-}" ] || die "checksum sidecar contains unexpected fields"
  [ "$expected_name" = "$(basename "$CANDY_BACKUP_FILE")" ] || \
    die "checksum sidecar names a different backup"
  case "$expected_checksum" in
    *[!0-9a-f]*|'') die "checksum sidecar is not lowercase SHA-256" ;;
  esac
  [ "${#expected_checksum}" -eq 64 ] || die "checksum sidecar is not SHA-256"
  if command -v shasum >/dev/null 2>&1; then
    actual_checksum="$(shasum -a 256 "$CANDY_BACKUP_FILE" | awk '{print $1}')"
  elif command -v sha256sum >/dev/null 2>&1; then
    actual_checksum="$(sha256sum "$CANDY_BACKUP_FILE" | awk '{print $1}')"
  else
    die "shasum or sha256sum is required to validate the checksum"
  fi
  [ "$actual_checksum" = "$expected_checksum" ] || die "backup checksum mismatch"
else
  die "checksum sidecar is missing: $checksum_file"
fi

recovery_db="match3_h5_recovery_$(date -u '+%Y%m%d%H%M%S')_$$"
case "$recovery_db" in
  match3_h5_recovery_[0-9]*) ;;
  *) die "unsafe generated recovery database name" ;;
esac
created=0
cleanup() {
  if [ "$created" -eq 1 ]; then
    compose exec -T postgres sh -eu -c \
      'dropdb --if-exists --force --username "$POSTGRES_USER" "$1"' sh "$recovery_db" >/dev/null 2>&1 || true
    created=0
  fi
}
trap cleanup EXIT
trap 'cleanup; exit 1' HUP INT TERM

compose exec -T postgres sh -eu -c \
  'createdb --username "$POSTGRES_USER" "$1"' sh "$recovery_db"
created=1
empty_count="$(compose exec -T postgres sh -eu -c \
  'psql --no-psqlrc --tuples-only --no-align --username "$POSTGRES_USER" --dbname "$1" --command "$2"' \
  sh "$recovery_db" "select count(*) from pg_tables where schemaname not in ('pg_catalog','information_schema')" | tr -d '[:space:]')"
[ "$empty_count" = "0" ] || die "recovery database was not empty before restore"

compose exec -T postgres sh -eu -c \
  'pg_restore --exit-on-error --single-transaction --no-owner --no-privileges --username "$POSTGRES_USER" --dbname "$1"' \
  sh "$recovery_db" <"$CANDY_BACKUP_FILE"

migration_count="$(compose exec -T postgres sh -eu -c \
  'psql --no-psqlrc --tuples-only --no-align --username "$POSTGRES_USER" --dbname "$1" --command "$2"' \
  sh "$recovery_db" 'select count(*) from app_schema_migrations' | tr -d '[:space:]')"
case "$migration_count" in
  ''|*[!0-9]*) die "restored migration count is invalid: $migration_count" ;;
esac
[ "$migration_count" -gt 0 ] || die "restored database has no migration history"
printf 'restore_drill=passed\ndatabase=%s\nmigrations=%s\n' "$recovery_db" "$migration_count"
