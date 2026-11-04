#!/usr/bin/env bash
# Applies the team-context migration to a throwaway Postgres 17 container and
# runs the RLS / cap checks. Needs Docker. Exit code 0 = all checks passed.
set -euo pipefail
# Keep git-bash from rewriting container paths like /check.sql.
export MSYS_NO_PATHCONV=1
here="$(cd "$(dirname "$0")" && pwd)"
# docker cp on Windows needs a native host path.
command -v cygpath >/dev/null && here="$(cygpath -m "$here")"
name="arunachala-schema-check-$$"
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT

docker run -d --name "$name" -e POSTGRES_PASSWORD=check postgres:17-alpine >/dev/null
docker cp "$here/../migrations" "$name:/migrations"
docker cp "$here/team_context_rls.sql" "$name:/check.sql"
until docker exec "$name" pg_isready -U postgres -q; do sleep 1; done
docker exec "$name" psql -U postgres -q -f /check.sql
