# Everything needed to work on all three stacks, and in particular to run
# `cd infra && make apply` for the one-time bootstrap (infra/README.md).
#
# Tools are installed directly rather than through devcontainer Features so
# the image can be built and checked with plain `docker build`.

FROM mcr.microsoft.com/devcontainers/python:3.14-bookworm

# Pinned to the versions CI uses, so `make lint` behaves the same in both.
ARG TERRAFORM_VERSION=1.15.8
ARG NODE_VERSION=v22.23.2

RUN apt-get update \
    && apt-get install -y --no-install-recommends unzip jq \
    && rm -rf /var/lib/apt/lists/*

# terraform
RUN arch="$(dpkg --print-architecture)" \
    && curl -fsSL -o /tmp/terraform.zip \
    "https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_linux_${arch}.zip" \
    && unzip -q /tmp/terraform.zip -d /usr/local/bin \
    && rm /tmp/terraform.zip \
    && terraform version

# aws cli v2 -- needed to authenticate before terraform, and to inspect the
# release artifacts in S3 later on.
RUN arch="$(uname -m)" \
    && curl -fsSL -o /tmp/awscli.zip "https://awscli.amazonaws.com/awscli-exe-linux-${arch}.zip" \
    && unzip -q /tmp/awscli.zip -d /tmp \
    && /tmp/aws/install \
    && rm -rf /tmp/awscli.zip /tmp/aws \
    && aws --version

# node, from the official tarball rather than a third-party apt repo: exact
# version, one fewer package source, and no piping a remote script into bash.
RUN case "$(uname -m)" in \
    x86_64) node_arch=x64 ;; \
    aarch64) node_arch=arm64 ;; \
    *) echo "unsupported arch $(uname -m)" >&2; exit 1 ;; \
    esac \
    && curl -fsSL -o /tmp/node.tar.xz \
    "https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-${node_arch}.tar.xz" \
    && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
    --exclude=CHANGELOG.md --exclude=LICENSE --exclude=README.md \
    && rm /tmp/node.tar.xz \
    && node --version \
    && npm --version

# poetry, as the vscode user so it lands on that user's PATH
USER vscode
RUN pipx install poetry==2.2.1 && poetry --version
USER root
