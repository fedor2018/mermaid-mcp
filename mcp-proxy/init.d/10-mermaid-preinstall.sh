#!/bin/sh
# Preinstall hook: prepare everything the mermaid-mcp stdio child needs.
#
# Three phases, in launch order:
#   1. system packages — apk add (only what is missing; installed packages
#      are a no-op, so the baked image pays nothing)
#   2. project source  — git:
#        /app/mermaid empty  → git clone --depth 1 -b $MERMAID_REF $MERMAID_REPO_URL
#        /app/mermaid/.git   → git fetch + reset --hard (pin to $MERMAID_REF)
#        baked in image      → skip (the source lives in a docker layer and
#                              cannot be updated anyway)
#   3. node deps       — npm ci --omit=dev (skipped when node_modules is
#                        already complete)
#
# With this hook the image can run in "thin-source" mode: bind an empty
# volume over /app/mermaid and the container installs packages, clones the
# repo, builds the deps and serves the server — no image rebuild.
#
# A failure in any phase aborts the container (restart: unless-stopped).
#
# Knobs (container env, all optional):
#   PREINSTALL_APK        apk packages for phase 1
#                         (default "font-dejavu font-liberation git")
#   MERMAID_REPO_URL      repo for phase 2 (default: fedor2018/mermaid-mcp fork)
#   MERMAID_REF           branch/tag to pin (default "main")
#   FORCE_PREINSTALL=1    run every phase even when its guard would skip
#   SKIP_INIT=1           skip all hooks (docker-entrypoint.sh level)
set -eu

TARGET="/app/mermaid"
REPO="${MERMAID_REPO_URL:-https://github.com/fedor2018/mermaid-mcp.git}"
REF="${MERMAID_REF:-main}"
APK_PACKAGES="${PREINSTALL_APK:-font-dejavu font-liberation git}"
FORCE="${FORCE_PREINSTALL:-0}"

# ── Phase 1: system packages (apk) ─────────────────────────────────────────
missing=""
for pkg in $APK_PACKAGES; do
  if ! apk info -e "$pkg" 2>/dev/null; then
    missing="$missing $pkg"
  fi
done

if [ -n "$missing" ]; then
  echo "[preinstall] apk add --no-cache$missing ..." >&2
  apk add --no-cache $missing
else
  echo "[preinstall] apk packages present — skipping phase 1" >&2
fi

# ── Phase 2: project source (git) ───────────────────────────────────────────
if [ -f "$TARGET/package.json" ] && [ "$FORCE" != "1" ]; then
  echo "[preinstall] source present (baked image) — skipping git phase" >&2
elif [ -d "$TARGET/.git" ]; then
  echo "[preinstall] git fetch + reset --hard origin/$REF ..." >&2
  git -C "$TARGET" fetch --depth 1 origin "$REF"
  git -C "$TARGET" reset --hard FETCH_HEAD
  echo "[preinstall] source pinned to $REF" >&2
else
  echo "[preinstall] git clone --depth 1 -b $REF $REPO ..." >&2
  [ -d "$TARGET" ] && rm -rf "$TARGET"
  git clone --depth 1 --branch "$REF" "$REPO" "$TARGET"
  echo "[preinstall] source cloned into $TARGET" >&2
fi

# ── Phase 3: node deps (npm) ────────────────────────────────────────────────
if [ -d "$TARGET/node_modules" ] \
  && [ -n "$(ls -A "$TARGET/node_modules" 2>/dev/null)" ] \
  && [ "$FORCE" != "1" ]; then
  echo "[preinstall] node_modules present — skipping (FORCE_PREINSTALL=1 to force)" >&2
  exit 0
fi

echo "[preinstall] npm ci --omit=dev in $TARGET ..." >&2
cd "$TARGET"
npm ci --omit=dev --cache /app/cache/npm
echo "[preinstall] done" >&2
