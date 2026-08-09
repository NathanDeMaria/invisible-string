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
