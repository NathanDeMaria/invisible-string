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
