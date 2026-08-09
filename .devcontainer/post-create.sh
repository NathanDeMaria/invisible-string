#!/usr/bin/env bash
# Installs the per-stack toolchains. Failures here shouldn't stop the
# container coming up -- terraform and the aws CLI come from features and are
# already present, so `cd infra && make apply` works regardless.
set -u

echo "==> poetry"
pipx install poetry || echo "   (skipped)"

echo "==> backend deps"
(cd backend && poetry install) || echo "   (skipped)"

echo "==> frontend deps"
(cd frontend && npm ci) || echo "   (skipped)"

echo
echo "Ready. To bootstrap the CI roles:"
echo "    cd infra && make init && make apply"
