# infra

Terraform for invisible-string. State lives at
`s3://nathan-terraform/invisible-string/terraform.tfstate`, alongside the
EndGame jobs stack but under its own key.

Right now this stack contains only the CI authentication: the GitHub Actions
OIDC provider and two roles. The App Runner service, ECR repository, artifact
bucket and refresh job land on top of it.

```sh
make init
make plan
make apply
make lint     # fmt + validate, what CI runs; no credentials needed
```

## Bootstrapping

This is circular on purpose: the roles that let CI run terraform are themselves
terraform. So the **first apply has to come from your laptop**, with your own
credentials. After that the stack manages itself.

```sh
cd infra
make init
make apply
```

Then wire the outputs into the deploy workflow:

```sh
terraform output ci_plan_role_arn
terraform output ci_apply_role_arn
```

If the AWS account already has a GitHub Actions OIDC provider — IAM allows
exactly one per URL, and a second `apply` anywhere in the account fails with
`EntityAlreadyExists` — set this in `terraform.tfvars` first:

```hcl
create_oidc_provider = false
```

The stack then references the existing provider by ARN instead of creating one.

## The two roles

| Role | Assumed by | Can |
|---|---|---|
| `invisible-string-ci-plan` | any branch push, any PR | read everything, write only the state lock |
| `invisible-string-ci-apply` | pushes to `main` only | apply, push to ECR |

`terraform plan` executes provider code and runs on every branch and pull
request, so it must not be able to reach credentials that can change anything.
That's the whole reason there are two roles rather than one.

### The `sub` claim

The trust policies key off `token.actions.githubusercontent.com:sub`, whose
shape depends on the event — which is the easy thing to get wrong:

| Event | `sub` |
|---|---|
| push to a branch | `repo:OWNER/REPO:ref:refs/heads/BRANCH` |
| pull request | `repo:OWNER/REPO:pull_request` |
| tag push | `repo:OWNER/REPO:ref:refs/tags/TAG` |

A plan role trusting only `ref:refs/heads/*` therefore fails on every PR, which
is why both patterns are listed.

The apply role uses `StringEquals`, not `StringLike`. With a wildcard, a branch
named `main-hotfix` would also match and get apply rights.

Verified against these subjects:

| Scenario | plan | apply |
|---|---|---|
| push to `main` | yes | yes |
| push to `claude/foo` | yes | no |
| pull request | yes | no |
| branch named `main-hotfix` | yes | no |
| tag push | no | no |
| fork of this repo | no | no |
| another repo, same owner | no | no |

## Permissions

The apply role gets `PowerUserAccess`, which covers App Runner, ECR, S3, Batch,
EventBridge, SNS and Secrets Manager, and explicitly denies IAM. The IAM this
stack genuinely needs is added as a separate policy scoped by name prefix
(`invisible-string-*`) rather than by attaching `IAMFullAccess` — so a
compromised workflow can manage this stack's roles but can't mint itself an
admin one.

Both roles get read/write on the state key prefix. Plan needs writes too,
because `use_lockfile = true` means taking the lock is an S3 write.

## A note on `.terraform.lock.hcl`

Not committed yet. `make init` generates it, and it **should** be committed
once it exists — it pins provider versions and checksums.

It's absent here because this repo's terraform was validated against a local
filesystem mirror of the AWS provider (the environment it was written in can't
reach `registry.terraform.io`), and a lock file produced that way records
hashes that won't match the registry's. Your first `make init` writes a correct
one; commit that.
