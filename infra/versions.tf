terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0"
    }
  }

  # Same bucket as the EndGame jobs stack, different key. `use_lockfile` is
  # S3-native locking, so there's no DynamoDB table to provision.
  backend "s3" {
    bucket       = "nathan-terraform"
    key          = "invisible-string/terraform.tfstate"
    region       = "us-east-2"
    encrypt      = true
    use_lockfile = true
  }
}
