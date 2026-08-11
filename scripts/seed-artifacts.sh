#!/usr/bin/env bash
# Publish the golden fixtures to the artifact bucket.
#
# Until the refresh job exists (DESIGN.md phase 5), the bucket is seeded by
# hand -- and "by hand" is how it ended up holding artifacts from a schema two
# revisions old, which 502s the API. This makes re-seeding one command, so a
# cassandra rev bump is followed by a republish rather than by an outage.
#
#   ./scripts/seed-artifacts.sh              # bucket from terraform output
#   ./scripts/seed-artifacts.sh my-bucket    # or name it
#   DRY_RUN=1 ./scripts/seed-artifacts.sh    # print the uploads, do nothing
#
# These are fixtures, not real model output. They exist so the site has
# something to render and so the deploy smoke test has rows to assert on.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fixtures="$repo_root/backend/tests/fixtures/models"

bucket="${1:-}"
if [ -z "$bucket" ]; then
  bucket="$(cd "$repo_root/infra" && terraform output -raw artifacts_bucket)"
fi

# Validate before uploading, not after. The whole point is to stop publishing
# artifacts the running API will reject -- doing that check against the same
# pinned cassandra schema the app imports is the only way to know.
echo "==> validating fixtures against cassandra's ModelRelease"
(
  cd "$repo_root/backend"
  poetry run python -c "
import json, pathlib, sys
from app.schema import ModelRelease

bad = 0
for path in sorted(pathlib.Path('tests/fixtures/models').rglob('latest.json')):
    try:
        ModelRelease.model_validate(json.loads(path.read_text()))
        print(f'    ok   {path}')
    except Exception as exc:
        bad += 1
        print(f'    FAIL {path}: {str(exc).splitlines()[0]}', file=sys.stderr)
sys.exit(1 if bad else 0)
"
)

echo "==> publishing to s3://$bucket/models/"
while IFS= read -r file; do
  model="$(basename "$(dirname "$file")")"
  league="$(basename "$(dirname "$(dirname "$file")")")"
  run_id="$(jq -r .run_id "$file")"

  # Both keys, per the layout in DESIGN.md section 2: runs/ is the immutable
  # history a rollback copies from, latest.json is the copy the API reads so
  # serving is one GET rather than a pointer chase.
  for key in "runs/$run_id.json" "latest.json"; do
    dest="s3://$bucket/models/$league/$model/$key"
    if [ -n "${DRY_RUN:-}" ]; then
      echo "    would copy $file -> $dest"
    else
      aws s3 cp "$file" "$dest" --content-type application/json
    fi
  done
done < <(find "$fixtures" -name latest.json | sort)

echo "done. The API picks these up within its cache TTL (60s by default)."
