provider "aws" {
  region = var.aws_region
}

data "aws_caller_identity" "current" {}

data "aws_partition" "current" {}

locals {
  owner = split("/", var.github_repository)[0]
  name  = split("/", var.github_repository)[1]

  # The ID-qualified subject GitHub actually issues. IDs rather than names is
  # the point of the format: a repository can be renamed, but its ID can't be
  # taken over by someone else claiming the old name.
  subject_repo = "repo:${local.owner}@${var.github_owner_id}/${local.name}@${var.github_repository_id}"

  # Kept alongside it so the policy still works if an account is ever issuing
  # the older name-only subjects. Both forms are exact, so listing both widens
  # nothing -- GitHub signs the claim, it can't be spoofed.
  subject_repo_legacy = "repo:${var.github_repository}"

  artifacts_bucket = coalesce(
    var.artifacts_bucket_name,
    "${var.resource_name_prefix}-artifacts-${data.aws_caller_identity.current.account_id}",
  )

  oidc_provider_arn = var.create_oidc_provider ? (
    aws_iam_openid_connect_provider.github[0].arn
    ) : (
    "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:oidc-provider/token.actions.githubusercontent.com"
  )
}
