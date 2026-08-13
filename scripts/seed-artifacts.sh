#!/usr/bin/env bash
# Publish ModelRelease artifacts to the artifact bucket.
#
# Until the refresh job exists (DESIGN.md phase 5), the bucket is written by
# hand -- and "by hand" is how it once ended up holding artifacts from a schema
# two revisions old, which 502s the API. Everything published goes through the
# same validation gate here, against the same pinned cassandra schema the
# running app imports, so a rev bump is followed by a republish rather than by
# an outage.
#
#   ./scripts/seed-artifacts.sh                     # the golden fixtures
#   ./scripts/seed-artifacts.sh --from ./releases   # a real run
#   ./scripts/seed-artifacts.sh --bucket my-bucket  # override the destination
#   DRY_RUN=1 ./scripts/seed-artifacts.sh --from ./releases
#
# The source directory is laid out the way the bucket is:
#
#   <dir>/models/{league}/{model}/latest.json
#   <dir>/models/{league}/{model}/runs/{run_id}.json
#
# Either file is enough. A directory holding only `runs/` -- which is what you
# get if a publish step wrote the immutable copy and stopped -- publishes fine:
# the newest run becomes latest.json, because latest.json is a *copy*, not a
# pointer, and the API reads it with one GET.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source_dir="$repo_root/backend/tests/fixtures"
bucket=""

while [ $# -gt 0 ]; do
  case "$1" in
    --from) source_dir="$(cd "$2" && pwd)"; shift 2 ;;
    --bucket) bucket="$2"; shift 2 ;;
    -h|--help) sed -n '2,25p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ ! -d "$source_dir/models" ]; then
  echo "no models/ directory under $source_dir" >&2
  echo "expected <dir>/models/{league}/{model}/{latest.json,runs/*.json}" >&2
  exit 2
fi

# The destination is the *artifact* bucket, which is not the bucket cassandra
# reads seasons and odds from. They're separate on purpose (DESIGN.md section
# 11.2): the App Runner instance role is scoped to this one alone, so the web
# tier has no path to EndGame's raw scrape data -- and equally, a release
# written to the EndGame bucket is somewhere the app cannot read even if it
# wanted to.
if [ -z "$bucket" ]; then
  bucket="$(cd "$repo_root/infra" && terraform output -raw artifacts_bucket)"
fi

# One file per league/model: latest.json when it exists, otherwise the newest
# run. Sorting by run id works because run ids are ISO-8601 timestamps.
pick_source_files() {
  find "$source_dir/models" -mindepth 2 -maxdepth 2 -type d | sort | while read -r dir; do
    if [ -f "$dir/latest.json" ]; then
      echo "$dir/latest.json"
    else
      find "$dir/runs" -name '*.json' 2>/dev/null | sort | tail -n 1
    fi
  done
}

mapfile -t files < <(pick_source_files)
if [ "${#files[@]}" -eq 0 ]; then
  echo "no release JSON found under $source_dir/models" >&2
  exit 2
fi

# Validate before uploading, not after. Doing it against the schema the app
# actually imports is the only check that means anything -- and it's cheap
# compared to noticing in production that /api/leagues went empty.
echo "==> validating ${#files[@]} release(s) against cassandra's ModelRelease"
(
  cd "$repo_root/backend"
  poetry run python -c '
import json, sys
from app.schema import ModelRelease

bad = 0
for path in sys.argv[1:]:
    try:
        release = ModelRelease.model_validate(json.loads(open(path).read()))
    except Exception as exc:
        bad += 1
        print(f"    FAIL {path}: {str(exc).splitlines()[0]}", file=sys.stderr)
        continue
    # Re-serializing with allow_nan=False is what proves a nan never reaches
    # the bucket: json.dumps writes it as a bare NaN token, which is not valid
    # JSON and which browsers reject.
    try:
        json.dumps(release.model_dump(mode="json"), allow_nan=False)
    except ValueError as exc:
        bad += 1
        print(f"    FAIL {path}: not JSON-safe ({exc})", file=sys.stderr)
        continue
    teams = len(release.ratings)
    fit = release.margin_calibration.kind if release.margin_calibration else "none"
    print(f"    ok   {release.league}/{release.model} "
          f"run={release.run_id} teams={teams} fit={fit}")
sys.exit(1 if bad else 0)
' "${files[@]}"
)

echo "==> publishing to s3://$bucket/models/"
for file in "${files[@]}"; do
  league_model_dir="$(dirname "$file")"
  # runs/<id>.json is one level deeper than latest.json.
  [ "$(basename "$league_model_dir")" = "runs" ] &&
    league_model_dir="$(dirname "$league_model_dir")"
  model="$(basename "$league_model_dir")"
  league="$(basename "$(dirname "$league_model_dir")")"
  run_id="$(jq -r .run_id "$file")"

  # Both keys, per the layout in DESIGN.md section 2: runs/ is the immutable
  # history a rollback copies from, latest.json is the copy the API reads.
  for key in "runs/$run_id.json" "latest.json"; do
    dest="s3://$bucket/models/$league/$model/$key"
    if [ -n "${DRY_RUN:-}" ]; then
      echo "    would copy $file -> $dest"
    else
      aws s3 cp "$file" "$dest" --content-type application/json
    fi
  done
done

echo "done. The API picks these up within its cache TTL (60s by default)."
