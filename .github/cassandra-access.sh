#!/usr/bin/env bash
# Gives a CI job read access to cassandra, which is private. Run once per job,
# before anything that fetches it: `uv sync`, `uv lock`, a docker build.
#
# `backend/uv.lock` pins cassandra by its https URL, and that stays the URL
# everywhere -- a laptop fetches it with its own GitHub login. Here git
# rewrites that one URL to ssh, and ssh authenticates with cassandra's deploy
# key: read-only, and good for that repository alone. uv fetches through the
# git binary, so it follows the rewrite without knowing about it.
#
# The key goes into an ssh-agent rather than a file, and the agent's socket
# into $GITHUB_ENV, so later steps -- and a docker build given `ssh: default`
# -- can use the key without it ever being written to disk.
#
# Needs CASSANDRA_DEPLOY_KEY in the environment (the repository secret).
set -euo pipefail

if [ -z "${CASSANDRA_DEPLOY_KEY:-}" ]; then
  echo "::error::CASSANDRA_DEPLOY_KEY is not set; cassandra is private and can't be fetched without it"
  exit 1
fi

eval "$(ssh-agent -s)" > /dev/null
printf '%s\n' "$CASSANDRA_DEPLOY_KEY" | ssh-add - 2> /dev/null
echo "SSH_AUTH_SOCK=$SSH_AUTH_SOCK" >> "$GITHUB_ENV"
echo "SSH_AGENT_PID=$SSH_AGENT_PID" >> "$GITHUB_ENV"

known_hosts="$(cd "$(dirname "$0")" && pwd)/github_known_hosts"
git config --global core.sshCommand \
  "ssh -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$known_hosts"
git config --global \
  url."git@github.com:NathanDeMaria/cassandra".insteadOf \
  "https://github.com/NathanDeMaria/cassandra"
