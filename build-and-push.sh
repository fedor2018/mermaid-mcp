#!/usr/bin/env bash
# build-and-push.sh — Build and push mermaid-mcp Docker image
#
# Builds the mermaid-mcp MCP server and pushes to Docker Hub
# under the tuiteraz namespace.
#
# Usage:
#   ./build-and-push.sh                            # Build + push (latest)
#   ./build-and-push.sh --tag v1.0.0               # Tag with specific version
#   ./build-and-push.sh --build-only               # Build only, skip push
#   ./build-and-push.sh --push-only                # Push only (assumes image is built)
#   ./build-and-push.sh --dry-run                  # Dry run (show commands, don't execute)
#   ./build-and-push.sh --platform linux/arm64     # Single platform (default: all)
#
# Prerequisites:
#   - Docker Desktop with buildx (multi-arch)
#   - Logged in to Docker Hub:  docker login
#
# Image registry: docker.io/tuiteraz/mermaid-mcp

set -euo pipefail

# ── Configuration ──────────────────────────────────────────────────────────────
REGISTRY="docker.io"
NAMESPACE="tuiteraz"
REPO="mermaid-mcp"
IMAGE_BASE="${REGISTRY}/${NAMESPACE}/${REPO}"

FORK_DIR="$(cd "$(dirname "$0")" && pwd)"

# ── Defaults ───────────────────────────────────────────────────────────────────
BUILD_ONLY=false
PUSH_ONLY=false
DRY_RUN=false
TAG="latest"
PLATFORM="linux/amd64,linux/arm64"

# ── Parse flags ────────────────────────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --build-only) BUILD_ONLY=true ;;
    --push-only)  PUSH_ONLY=true ;;
    --dry-run)    DRY_RUN=true ;;
    --tag)
      TAG="$2"
      shift 2
      ;;
    --platform)
      PLATFORM="$2"
      shift 2
      ;;
    --help)
      echo "Usage: $0 [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  --build-only         Build only, skip push"
      echo "  --push-only          Push only (assumes image is built locally)"
      echo "  --dry-run            Show commands without executing"
      echo "  --tag TAG            Tag to use (default: latest)"
      echo "  --platform PLATFORM  Docker platform(s), comma-separated (default: linux/amd64,linux/arm64)"
      echo ""
      echo "Examples:"
      echo "  $0                                              # Build + push (latest)"
      echo "  $0 --tag v1.0.0                                 # Tag with version"
      echo "  $0 --build-only                                 # Build only"
      echo "  $0 --platform linux/arm64                       # ARM64 only"
      echo "  $0 --dry-run                                    # Dry run"
      echo ""
      echo "Note: Requires docker login to ${REGISTRY}/${NAMESPACE}"
      exit 0
      ;;
    --)
      shift
      break
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

# ── Pre-flight checks ─────────────────────────────────────────────────────────
echo "=== mermaid-mcp build-and-push ==="
echo ""

# Check Docker
docker ps >/dev/null 2>&1 || { echo "ERROR: Docker is not running"; exit 1; }

# Check buildx
if ! docker buildx version >/dev/null 2>&1; then
  echo "ERROR: docker buildx not available. Install: docker buildx create --use"
  exit 1
fi

# Check Dockerfile
if [ ! -f "$FORK_DIR/Dockerfile" ]; then
  echo "ERROR: Dockerfile not found: $FORK_DIR/Dockerfile"
  exit 1
fi

# Check current branch
CURRENT_BRANCH=$(git -C "$FORK_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
echo "Current branch:    $CURRENT_BRANCH"
echo "Image base:        ${IMAGE_BASE}"
echo "Tag:               ${TAG}"
echo "Platform:          ${PLATFORM}"
echo ""

# ── Helper functions ───────────────────────────────────────────────────────────
run_cmd() {
  if [ "$DRY_RUN" = true ]; then
    echo "  [DRY RUN] Would execute: $*"
    return 0
  fi
  "$@"
}

# ── Build phase ────────────────────────────────────────────────────────────────
if [ "$PUSH_ONLY" = false ]; then
  image_tag="${IMAGE_BASE}:${TAG}"
  local_tag="${NAMESPACE}/${REPO}:${TAG}"

  echo "=== Building: ${image_tag} ==="
  echo "  Image: ${image_tag}"
  echo "  Local: ${local_tag}"
  echo ""

  run_cmd docker buildx build \
    --platform "${PLATFORM}" \
    --tag "${local_tag}" \
    --tag "${image_tag}" \
    --progress=plain \
    "$FORK_DIR" \
    2>&1

  echo ""
  echo "  ✓ Build complete: ${image_tag}"
  echo ""
fi

# ── Push phase ─────────────────────────────────────────────────────────────────
if [ "$BUILD_ONLY" = false ]; then
  image_tag="${IMAGE_BASE}:${TAG}"

  echo "=== Pushing: ${image_tag} ==="

  run_cmd docker push "${image_tag}"

  echo "  ✓ Pushed: ${image_tag}"
  echo ""

  # ── Summary ────────────────────────────────────────────────────────────────
  echo "=== Summary ==="
  echo "  ${image_tag}"
  echo ""
  echo "Run with:"
  echo "  docker run ${image_tag}"
  echo ""
fi

echo "Done ✓"
