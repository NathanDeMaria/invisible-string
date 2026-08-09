output "ci_plan_role_arn" {
  description = "role-to-assume for plan jobs (any branch, any PR)"
  value       = aws_iam_role.ci_plan.arn
}

output "ci_apply_role_arn" {
  description = "role-to-assume for apply jobs (main only)"
  value       = aws_iam_role.ci_apply.arn
}

output "oidc_provider_arn" {
  description = "GitHub Actions OIDC provider trusted by both roles"
  value       = local.oidc_provider_arn
}

output "artifacts_bucket" {
  description = "Set INVISIBLE_STRING_RELEASES_BUCKET to this to serve real releases"
  value       = aws_s3_bucket.artifacts.bucket
}

output "artifacts_bucket_arn" {
  description = "For scoping the App Runner instance role and the refresh job"
  value       = aws_s3_bucket.artifacts.arn
}
