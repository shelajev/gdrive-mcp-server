#! /bin/bash
set -ex 
docker buildx build --builder cloud-docker-devrel --platform linux/amd64,linux/arm64 --tag olegselajev241/mcp-gdrive-sse:latest --push .