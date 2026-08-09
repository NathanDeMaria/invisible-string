# The model-artifact bucket: ModelRelease JSON and the rating-history parquet
# that the API reads (DESIGN.md section 11.2).
#
# Deliberately separate from the EndGame bucket that holds the raw scrape data.
# It gets its own versioning and lifecycle, and it means the web tier's instance
# role can be scoped to this bucket alone -- App Runner ends up with no path to
# the raw data at all.

resource "aws_s3_bucket" "artifacts" {
  bucket = local.artifacts_bucket

  # Left at the default (false) on purpose: `terraform destroy` should fail
  # rather than quietly delete published releases.
  force_destroy = false
}

# Recovering a bad `latest.json` overwrite. The runs/ history is the durable
# record, but versioning makes a mistaken pointer flip undoable directly.
resource "aws_s3_bucket_versioning" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_public_access_block" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  # The app reads with its instance role, never anonymously, so nothing here
  # needs to be public.
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# ACLs disabled; the bucket owner owns every object. Relevant because the
# refresh job writes here under a different role than the app reads with.
resource "aws_s3_bucket_ownership_controls" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  # `latest.json` is rewritten every refresh, so with versioning on it would
  # otherwise accumulate a new noncurrent version per day forever. Safe to
  # expire: every release is also written to runs/{run_id}.json, which is the
  # permanent record and is never overwritten.
  rule {
    id     = "expire-noncurrent-versions"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 90
    }
  }

  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  depends_on = [aws_s3_bucket_versioning.artifacts]
}
