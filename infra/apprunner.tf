# The service itself. App Runner rather than Fargate + ALB (DESIGN.md
# section 7): no load balancer, no target groups, no VPC, and a warm container
# so the release cache in the app actually pays off.
#
# NOTE ON ORDERING. App Runner validates the image at create time, so this
# cannot be created before one exists in ECR. That makes the first run a
# three-step sequence rather than a single apply:
#
#   1. apply with create_app_runner_service = false  -> ECR repository exists
#   2. push an image (merge to main, or `make push`) -> :latest exists
#   3. set create_app_runner_service = true, apply   -> service comes up
#
# Without the flag, step 1 fails outright with an image-not-found error, which
# reads like a bug rather than an ordering constraint.

locals {
  create_service = var.create_app_runner_service ? 1 : 0
}

# ------------------------------------------------------------------------------
# Instance role: what the running app may do.
# ------------------------------------------------------------------------------

data "aws_iam_policy_document" "apprunner_instance_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["tasks.apprunner.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "apprunner_instance" {
  name               = "${var.resource_name_prefix}-apprunner-instance"
  description        = "Runtime role for the invisible-string App Runner service"
  assume_role_policy = data.aws_iam_policy_document.apprunner_instance_assume.json
}

# Read-only, and only this bucket. Note that this is no longer the *whole* of
# what the web tier can read: the job health dashboard adds read access to
# EndGame's bucket below (DESIGN.md section 12.2, amending 11.2). What the
# two-bucket split still buys is independent versioning, lifecycle and
# retention here, and one clear owner for each bucket.
data "aws_iam_policy_document" "apprunner_artifacts_read" {
  statement {
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.artifacts.arn}/*"]
  }

  # Needed as well as GetObject: the API discovers which leagues and models
  # exist by listing prefixes, so GetObject alone would 403 on /api/leagues.
  statement {
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.artifacts.arn]
  }
}

resource "aws_iam_policy" "apprunner_artifacts_read" {
  name        = "${var.resource_name_prefix}-apprunner-artifacts-read"
  description = "Read model releases from the artifact bucket"
  policy      = data.aws_iam_policy_document.apprunner_artifacts_read.json
}

resource "aws_iam_role_policy_attachment" "apprunner_artifacts_read" {
  role       = aws_iam_role.apprunner_instance.name
  policy_arn = aws_iam_policy.apprunner_artifacts_read.arn
}

# ------------------------------------------------------------------------------
# Job health: reading EndGame's Batch queue and bucket (DESIGN.md section 12).
#
# Both names come from the Batch stack's state, which is where EndGame/jobs
# reads the same two values from. That stack owns the queue and the bucket, so
# it is the source of truth for both: nothing here has to be kept in sync by
# hand, and a rename over there fails this plan rather than an 8am job or, in
# our case, a dashboard that quietly goes empty.
#
# The coupling is worth naming. Every plan of this stack now reads that state
# object, so if it moves, this stack stops planning until the key below
# changes. A data source read takes no lock and needs only s3:GetObject, which
# ReadOnlyAccess already gives the plan role -- the same reasoning EndGame's
# oidc.tf spells out for its own copy of this read.
# ------------------------------------------------------------------------------

data "terraform_remote_state" "batch" {
  backend = "s3"

  # Hardcoded rather than reusing var.state_bucket: that variable is where
  # *this* stack keeps its state, and the two being the same bucket is a
  # coincidence worth not encoding. Mirrors EndGame/jobs.
  config = {
    bucket = "nathan-terraform"
    key    = "batch-state"
    region = "us-east-2"
  }
}

locals {
  # `batch:ListJobs` takes a queue name or a full ARN, and so does the app's
  # INVISIBLE_STRING_BATCH_JOB_QUEUE -- so the ARN goes to both, and no name
  # has to be split back out of it.
  endgame_job_queue_arn = data.terraform_remote_state.batch.outputs.job_queue_arn
  endgame_bucket        = data.terraform_remote_state.batch.outputs.bucket
}

data "aws_iam_policy_document" "apprunner_job_health" {
  # ListJobs is the only Batch call the app makes: one AFTER_CREATED_AT-
  # filtered pass over the queue covers every status. DescribeJobs belongs to
  # the admin refresh endpoint (section 5b), which doesn't exist yet, so it
  # isn't granted yet either.
  statement {
    effect    = "Allow"
    actions   = ["batch:ListJobs"]
    resources = [local.endgame_job_queue_arn]
  }

  # Listing is most of the volume half: odds pulls per league per day, and
  # which season objects exist. The prefix condition is what keeps this from
  # being "read EndGame's bucket" in general.
  statement {
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = ["arn:${data.aws_partition.current.partition}:s3:::${local.endgame_bucket}"]

    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["seasons/*", "odds/*"]
    }
  }

  # The two objects the app opens: the newest odds pull per league, for a real
  # record count, and each league's season file, to count games by date
  # (section 12.4). This is the grant that spends the last of the boundary in
  # 11.2 -- with it, the web tier can read raw scrape data.
  statement {
    effect  = "Allow"
    actions = ["s3:GetObject"]
    resources = [
      "arn:${data.aws_partition.current.partition}:s3:::${local.endgame_bucket}/odds/*",
      "arn:${data.aws_partition.current.partition}:s3:::${local.endgame_bucket}/seasons/*",
    ]
  }
}

resource "aws_iam_policy" "apprunner_job_health" {
  name        = "${var.resource_name_prefix}-apprunner-job-health"
  description = "Read EndGame's Batch queue and scrape data for the job health dashboard"
  policy      = data.aws_iam_policy_document.apprunner_job_health.json
}

resource "aws_iam_role_policy_attachment" "apprunner_job_health" {
  role       = aws_iam_role.apprunner_instance.name
  policy_arn = aws_iam_policy.apprunner_job_health.arn
}

# ------------------------------------------------------------------------------
# Access role: how App Runner pulls the image. Distinct from the instance role
# -- this one is used by the service before the container exists.
# ------------------------------------------------------------------------------

data "aws_iam_policy_document" "apprunner_access_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["build.apprunner.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "apprunner_access" {
  name               = "${var.resource_name_prefix}-apprunner-access"
  description        = "Lets App Runner pull the image from ECR"
  assume_role_policy = data.aws_iam_policy_document.apprunner_access_assume.json
}

resource "aws_iam_role_policy_attachment" "apprunner_access" {
  role       = aws_iam_role.apprunner_access.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AWSAppRunnerServicePolicyForECRAccess"
}

# ------------------------------------------------------------------------------
# Service
# ------------------------------------------------------------------------------

resource "aws_apprunner_auto_scaling_configuration_version" "app" {
  auto_scaling_configuration_name = var.resource_name_prefix

  # One instance is the floor App Runner allows; there's no scale-to-zero.
  min_size = 1
  max_size = var.app_runner_max_size

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_apprunner_service" "app" {
  count = local.create_service

  service_name = var.resource_name_prefix

  source_configuration {
    # The push *is* the deploy: image.yml moves :latest and App Runner rolls
    # forward on its own, so shipping the app never runs terraform.
    auto_deployments_enabled = true

    authentication_configuration {
      access_role_arn = aws_iam_role.apprunner_access.arn
    }

    image_repository {
      image_identifier      = "${aws_ecr_repository.app.repository_url}:latest"
      image_repository_type = "ECR"

      image_configuration {
        port = "8000"

        # Changing these replaces the service's configuration and rolls a new
        # revision, so applying this is itself the deploy for the job health
        # dashboard -- no image push needed.
        runtime_environment_variables = {
          INVISIBLE_STRING_RELEASES_BUCKET = aws_s3_bucket.artifacts.bucket
          INVISIBLE_STRING_STATIC_DIR      = "/srv/static"
          INVISIBLE_STRING_BATCH_JOB_QUEUE = local.endgame_job_queue_arn
          INVISIBLE_STRING_ENDGAME_BUCKET  = local.endgame_bucket
        }
      }
    }
  }

  instance_configuration {
    cpu               = var.app_runner_cpu
    memory            = var.app_runner_memory
    instance_role_arn = aws_iam_role.apprunner_instance.arn
  }

  health_check_configuration {
    protocol = "HTTP"
    path     = "/healthz"
    interval = 10
    timeout  = 5
    # Two rather than the default one, so a single slow response during a
    # rollout doesn't cycle an otherwise healthy revision.
    healthy_threshold   = 2
    unhealthy_threshold = 5
  }

  auto_scaling_configuration_arn = aws_apprunner_auto_scaling_configuration_version.app.arn
}
