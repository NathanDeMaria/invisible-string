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
