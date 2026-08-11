#!/bin/bash
# SessionStart hook for Claude Code on the web.
#
# The container arrives with poetry, node, npm, terraform and uv already on
# PATH, so most of the toolchain needs nothing. One thing does: Python.
#
# The image ships uv 0.8.17, which predates CPython 3.14's release, so its
# python-build-standalone index tops out at 3.14.0rc2. That rc is not merely
# "close enough" -- pydantic cannot construct *any* model on it:
#
#   TypeError: _eval_type() got an unexpected keyword argument
#   'prefer_fwd_module'
#
# because typing._eval_type's signature changed between rc2 and final. Since
# backend/ is FastAPI on pydantic and depends on cassandra (^3.14), that means
# every test and every `ty check` fails on import until a real 3.14 exists.
#
# Nothing here is needed on a laptop -- the devcontainer already pins
# mcr.microsoft.com/devcontainers/python:3.14-bookworm -- so the hook is a
# no-op outside the remote environment.

set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}"

# ------------------------------------------------------------------------------
# Python
# ------------------------------------------------------------------------------

# Final releases list as `cpython-3.14.<patch>-`; a pre-release lists as
# `cpython-3.14.0rc2-`, which this pattern deliberately does not match. So an
# image that already ships a current uv skips the upgrade entirely.
#
# `pip install --user` rather than `uv self update`: the environment's network
# policy denies releases.astral.sh, which is where self-update fetches from,
# while pypi.org is reachable directly.
if ! uv python list 2>/dev/null | grep -qE '^cpython-3\.14\.[0-9]+-'; then
  echo "==> upgrading uv (its Python index predates the 3.14 release)"
  python3 -m pip install --user --quiet --upgrade uv
  hash -r
fi

# Tracks the newest 3.14.x rather than pinning a patch, which is what CI's
# `actions/setup-python: "3.14"` resolves to as well. No-op once installed.
echo "==> installing CPython 3.14"
uv python install 3.14
python_bin="$(uv python find 3.14)"

# The guard that gives this hook its point. Getting a pre-release here is the
# exact failure the comment above describes, and it surfaces later as a wall of
# pydantic tracebacks that look like a code problem rather than a toolchain
# one. Fail loudly and immediately instead.
python_version="$("$python_bin" -c 'import sys; print(sys.version.split()[0])')"
case "$python_version" in
  *a* | *b* | *rc*)
    echo "hook: refusing Python $python_version -- pydantic cannot build" >&2
    echo "      models on a 3.14 pre-release. Is uv current?" >&2
    exit 1
    ;;
esac
echo "    using Python $python_version at $python_bin"

# ------------------------------------------------------------------------------
# Stacks
# ------------------------------------------------------------------------------

echo "==> backend"
(
  cd backend
  poetry env use "$python_bin"
  poetry install
)

echo "==> frontend"
(
  cd frontend
  npm install
)

# infra/ needs nothing installed -- terraform 1.15.8 is already on PATH, the
# same version CI pins. Note that `make -C infra lint` still won't pass here:
# it runs `terraform init -backend=false`, which reaches registry.terraform.io
# to fetch the AWS provider, and the environment's network policy denies that
# host. That's an environment setting rather than anything this hook can fix.
echo "==> infra: terraform $(terraform version -json | jq -r .terraform_version) already present"

echo "ready"
