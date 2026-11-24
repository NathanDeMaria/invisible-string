# The site's password (backend `app.auth`, DESIGN.md section 3).
#
# The secret is made once by hand, not by terraform, so its value never sits in
# state, a plan or CI:
#
#   aws secretsmanager create-secret --region us-east-2 \
#     --name invisible-string/password \
#     --secret-string "$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 32)"
#
# 32 random letters and digits, about 190 bits: generated rather than chosen,
# so nothing about it can be guessed. Read it back with get-secret-value into a
# password manager.
#
# Rotating is `put-secret-value` with a new one, then a redeploy so App Runner
# re-reads it (`aws apprunner start-deployment`). Every session cookie is signed
# with a key derived from the password, so a rotation logs everyone out.
#
# A data source rather than a resource because a managed secret *version* reads
# its value back on every refresh, and the plan role (ReadOnlyAccess, assumable
# from any branch) can't -- and shouldn't be able to -- call GetSecretValue.
# Describing the secret is all a plan needs. Until the command above has been
# run, plans fail here, which is the reminder.

data "aws_secretsmanager_secret" "password" {
  name = "${var.resource_name_prefix}/password"
}

# App Runner fetches runtime secrets with the instance role.
data "aws_iam_policy_document" "apprunner_password_read" {
  statement {
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [data.aws_secretsmanager_secret.password.arn]
  }
}

resource "aws_iam_policy" "apprunner_password_read" {
  name        = "${var.resource_name_prefix}-apprunner-password-read"
  description = "Read the site password for the login page"
  policy      = data.aws_iam_policy_document.apprunner_password_read.json
}

resource "aws_iam_role_policy_attachment" "apprunner_password_read" {
  role       = aws_iam_role.apprunner_instance.name
  policy_arn = aws_iam_policy.apprunner_password_read.arn
}
