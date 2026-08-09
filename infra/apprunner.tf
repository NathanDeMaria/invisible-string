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

# Read-only, and only this bucket. The web tier has no path to EndGame's raw
# scrape data at all -- one of the reasons the artifacts live in their own
# bucket (DESIGN.md section 11.2).
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

        runtime_environment_variables = {
          INVISIBLE_STRING_RELEASES_BUCKET = aws_s3_bucket.artifacts.bucket
          INVISIBLE_STRING_STATIC_DIR      = "/srv/static"
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
