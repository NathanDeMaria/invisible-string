# infra

Terraform for invisible-string. State lives at
`s3://nathan-terraform/invisible-string/terraform.tfstate`, alongside the
EndGame jobs stack but under its own key.

Contents so far: the CI authentication (GitHub Actions OIDC provider and two
roles) and the model-artifact bucket. The App Runner service, ECR repository
and refresh job land on top of those.

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

The trust policies key off `token.actions.githubusercontent.com:sub`. Two
things about it are easy to get wrong, and both produce the same unhelpful
`Not authorized to perform sts:AssumeRoleWithWebIdentity` while every piece of
configuration looks correct.

**It is ID-qualified, not name-based.** GitHub issues subjects in an immutable
form that embeds the numeric owner and repository IDs:

```
repo:NathanDeMaria@5595197/invisible-string@1328209264:ref:refs/heads/main
```

not `repo:NathanDeMaria/invisible-string:ref:refs/heads/main`. Matching on
names alone never matches anything. IDs are the point of the format — a
repository can be renamed, but nobody else can take over its ID by claiming the
old name. `github_owner_id` and `github_repository_id` carry them; the
name-based form is also listed, harmlessly, in case an account ever issues it.

**Its shape depends on the event:**

| Event | tail of `sub` |
|---|---|
| push to a branch | `:ref:refs/heads/BRANCH` |
| pull request | `:pull_request` |
| tag push | `:ref:refs/tags/TAG` |

A plan role trusting only `ref:refs/heads/*` fails on every PR, which is why
both are listed.

The apply role's patterns keep the branch segment literal (`refs/heads/main`,
no wildcard), so a branch named `main-hotfix` can't pick up apply rights.

Verified against these subjects, including the real one captured from a run:

| Scenario | plan | apply |
|---|---|---|
| push to `main` | yes | yes |
| push to `claude/foo` | yes | no |
| pull request | yes | no |
| branch named `main-hotfix` | yes | no |
| tag push | no | no |
| different repository ID | no | no |
| different owner ID | no | no |
| look-alike owner name | no | no |

If this ever fails again, print the token's claims in the workflow rather than
reasoning about them — the subject is the only thing that isn't visible from
the AWS side.

## The artifact bucket

Holds the `ModelRelease` JSON and rating history the API serves
(DESIGN.md section 11.2). Owned by this stack rather than by EndGame, so it
gets its own versioning and lifecycle — and so the App Runner instance role
can be scoped to this bucket alone, leaving the web tier no path to the raw
scrape data.

```sh
terraform output artifacts_bucket
```

Feed that to the app as `INVISIBLE_STRING_RELEASES_BUCKET`.

The name defaults to `invisible-string-artifacts-<account id>`. The account
suffix isn't decoration: S3 bucket names are globally unique across every AWS
account, so the unsuffixed name is likely already taken by a stranger. Override
with `artifacts_bucket_name` if you'd rather pick your own.

| Setting | Why |
|---|---|
| Versioning on | A bad `latest.json` overwrite is recoverable without digging through `runs/` |
| Noncurrent versions expire after 90d | `latest.json` is rewritten every refresh; without this, versioning accumulates one copy per day forever. Safe because every release is also written to `runs/{run_id}.json`, which is never overwritten. |
| Public access fully blocked | The app reads with its instance role, never anonymously |
| `BucketOwnerEnforced` | ACLs off. The refresh job writes under a different role than the app reads with, and this keeps object ownership unambiguous. |
| `force_destroy = false` | `terraform destroy` should fail rather than quietly delete published releases |

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
