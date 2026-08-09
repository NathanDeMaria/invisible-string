variable "aws_region" {
  description = "AWS region to deploy resources into"
  type        = string
  default     = "us-east-2"
}

variable "github_repository" {
  description = "owner/repo allowed to assume the CI roles"
  type        = string
  default     = "NathanDeMaria/invisible-string"
}

variable "github_owner_id" {
  description = <<-EOT
    Numeric ID of the GitHub account owning the repository.

    GitHub issues OIDC subjects in an immutable, ID-qualified form --
    `repo:OWNER@OWNER_ID/REPO@REPO_ID:...` -- rather than by name, so the trust
    policy has to match on IDs. Matching on names alone silently never matches
    and every assume fails with a generic "Not authorized".

      gh api users/NathanDeMaria --jq .id
  EOT
  type        = number
  default     = 5595197
}

variable "github_repository_id" {
  description = <<-EOT
    Numeric ID of the repository. See github_owner_id.

      gh api repos/NathanDeMaria/invisible-string --jq .id
  EOT
  type        = number
  default     = 1328209264
}

variable "create_oidc_provider" {
  description = <<-EOT
    Create the GitHub Actions OIDC provider. Set false if the account already
    has one -- IAM allows only a single provider per URL, and a second
    `terraform apply` in another stack would fail with EntityAlreadyExists.
  EOT
  type        = bool
  default     = true
}

variable "state_bucket" {
  description = "Bucket holding terraform state. Plan needs write access for the lock file."
  type        = string
  default     = "nathan-terraform"
}

variable "state_key_prefix" {
  description = "Key prefix within the state bucket that CI may lock and write"
  type        = string
  default     = "invisible-string/"
}

variable "resource_name_prefix" {
  description = "Prefix for resources this stack creates. Scopes the apply role's IAM permissions."
  type        = string
  default     = "invisible-string"
}

variable "artifacts_bucket_name" {
  description = <<-EOT
    Name for the model-artifact bucket.

    Defaults to <prefix>-artifacts-<account id>. S3 bucket names are globally
    unique across every AWS account, so an unsuffixed name is likely to be
    taken by someone else entirely.
  EOT
  type        = string
  default     = null
}

variable "create_app_runner_service" {
  description = <<-EOT
    Create the App Runner service.

    Defaults to false because App Runner validates the image at create time and
    would fail before one has ever been pushed. First run is: apply with this
    false to get the ECR repository, push an image, then set it true and apply
    again. See the ordering note in apprunner.tf.
  EOT
  type        = bool
  default     = false
}

variable "app_runner_cpu" {
  description = "vCPU for the service. The app is I/O bound and caches in memory."
  type        = string
  default     = "0.25 vCPU"
}

variable "app_runner_memory" {
  description = "Memory for the service"
  type        = string
  default     = "0.5 GB"
}

variable "app_runner_max_size" {
  description = "Autoscaling ceiling. Min is always 1; App Runner has no scale-to-zero."
  type        = number
  default     = 2
}
