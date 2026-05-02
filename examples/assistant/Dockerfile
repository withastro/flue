FROM docker.io/cloudflare/sandbox:0.9.2

# The base image already provides node, git, curl, and /workspace.
# Layer in any extra tools your agent needs.
RUN apt-get update && apt-get install -y python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*
