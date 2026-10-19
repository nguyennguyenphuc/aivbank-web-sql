#!/bin/bash
# shellcheck disable=SC2016

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
# shellcheck disable=SC1091
. "$SCRIPT_DIR/candy-common.sh"

load_release_context
resolve_compose_command
assert_rootless_connection
wait_for_service_health postgres 30 2

if ! compose exec -T postgres sh -eu -c '
  secret=/run/secrets/match3-app-password
  test -f "$secret"
  awk '\''
    NR > 1 { exit 1 }
    length($0) < 32 || length($0) > 128 { exit 1 }
    $0 !~ /^[A-Za-z0-9_-]+$/ { exit 1 }
    END { if (NR != 1) exit 1 }
  '\'' "$secret"
' >/dev/null; then
  die "mounted match3 app password must contain one 32-128 character URL-safe secret"
fi

{
  printf '%s\n' \
    '\set ON_ERROR_STOP on' \
    'create temporary table app_bootstrap_secret(secret text not null);' \
    '\copy app_bootstrap_secret(secret) from stdin'
  compose exec -T postgres sh -eu -c 'tr -d '\''\n'\'' </run/secrets/match3-app-password'
  printf '%s\n' '' '\.'
  printf '%s\n' \
    'do $bootstrap$' \
    'declare app_password text;' \
    'begin' \
    '  if current_user = '\''match3_app'\'' then' \
    '    raise exception '\''bootstrap must run as the PostgreSQL admin role'\'';' \
    '  end if;' \
    '  select secret into strict app_password from app_bootstrap_secret;' \
    '  if exists (select 1 from pg_roles where rolname = '\''match3_app'\'') then' \
    '    execute format('\''alter role match3_app with login password %L nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls'\'', app_password);' \
    '  else' \
    '    execute format('\''create role match3_app with login password %L nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls'\'', app_password);' \
    '  end if;' \
    'end' \
    '$bootstrap$;' \
    'select format('\''alter database %I owner to match3_app'\'', current_database()) \gexec' \
    'select format('\''grant connect on database %I to match3_app'\'', current_database()) \gexec' \
    'select format('\''grant usage on schema %I to match3_app'\'', nspname) from pg_namespace where nspname !~ '\''^pg_'\'' and nspname <> '\''information_schema'\'' \gexec' \
    'select format('\''grant select, insert, update, delete on all tables in schema %I to match3_app'\'', nspname) from pg_namespace where nspname !~ '\''^pg_'\'' and nspname <> '\''information_schema'\'' \gexec' \
    'select format('\''grant usage, select on all sequences in schema %I to match3_app'\'', nspname) from pg_namespace where nspname !~ '\''^pg_'\'' and nspname <> '\''information_schema'\'' \gexec' \
    'alter default privileges grant select, insert, update, delete on tables to match3_app;' \
    'alter default privileges grant usage, select on sequences to match3_app;' \
    'drop table app_bootstrap_secret;'
} | compose exec -T postgres sh -eu -c \
  'psql --quiet --no-psqlrc --username "$POSTGRES_USER" --dbname "$POSTGRES_DB"'

note "match3_app is the non-superuser owner of the dedicated app database; no password value was logged"
