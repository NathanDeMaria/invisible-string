# Matches EndGame/jobs: `make plan` / `make apply`, tfvars optional.
TF_ARGS = $(if $(wildcard terraform.tfvars),-var-file=terraform.tfvars,)

init:
	terraform init

plan:
	terraform plan $(TF_ARGS)

apply:
	terraform apply $(TF_ARGS)

# What CI runs. No credentials and no backend, so it works anywhere.
lint:
	terraform fmt -check -recursive
	terraform init -backend=false
	terraform validate
