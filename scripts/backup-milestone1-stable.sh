#!/usr/bin/env bash
set -euo pipefail

# Where we are
REPO="$(pwd)"
LABEL="MILESTONE1-STABLE"
TS="$(date +%Y%m%d-%H%M%S)"
BACKUPS_DIR="$REPO/backups"
BACKUP_DIR="$BACKUPS_DIR/${TS}-${LABEL}"

mkdir -p "$BACKUP_DIR"

echo "➡️  Backing up repo at: $REPO"
echo "➡️  Label           : $LABEL"
echo "➡️  Backup folder   : $BACKUP_DIR"

#######################################
# 1) Save .vercel (Vercel link info)
#######################################
if [ -d "$REPO/.vercel" ]; then
  mkdir -p "$BACKUP_DIR/.vercel"
  cp -R "$REPO/.vercel/"* "$BACKUP_DIR/.vercel/" || true
  echo "➡️  Saved .vercel/ link metadata"
else
  echo "⚠️  No .vercel directory found (project may not be linked locally)"
fi

#######################################
# 2) Save Vercel env listing
#######################################
if command -v vercel >/dev/null 2>&1; then
  echo "➡️  Capturing Vercel envs…"
  vercel env ls > "$BACKUP_DIR/vercel_env_ls.txt" || echo "⚠️  vercel env ls failed"
else
  echo "⚠️  vercel CLI not found; skipping env snapshot"
fi

#######################################
# 3) Save KB snapshot from blob
#######################################
KB_URL="https://ynyzmdodop38gqsz.public.blob.vercel-storage.com/kb.json"
echo "➡️  Downloading kb.json from blob…"
if curl -fsSL "$KB_URL" -o "$BACKUP_DIR/kb.json"; then
  echo "   ✓ kb.json saved"
else
  echo "⚠️  Could not download kb.json from blob"
fi

#######################################
# 4) Save git metadata (status, branch, HEAD)
#######################################
echo "➡️  Capturing git metadata…"
git status > "$BACKUP_DIR/git_status.txt" 2>/dev/null || true
git rev-parse --abbrev-ref HEAD > "$BACKUP_DIR/git_branch.txt" 2>/dev/null || true
git rev-parse HEAD > "$BACKUP_DIR/git_head.txt" 2>/dev/null || true

#######################################
# 5) Source snapshot (excluding heavy stuff)
#######################################
echo "➡️  Creating source snapshot…"

cat > "$BACKUP_DIR/.backup-excludes" << 'EX'
node_modules
.next
.vercel
.DS_Store
backups
backup-*.tar.gz
EX

tar czf "$BACKUP_DIR/src-${TS}.tar.gz" \
  --exclude-from="$BACKUP_DIR/.backup-excludes" \
  -C "$REPO" .

#######################################
# 6) Pack backup folder into a single archive
#######################################
ARCHIVE="$REPO/backup-${TS}-${LABEL}.tar.gz"
echo "➡️  Packaging full backup → $ARCHIVE"

mkdir -p "$BACKUPS_DIR"
tar czf "$ARCHIVE" -C "$BACKUPS_DIR" "$(basename "$BACKUP_DIR")"

# SHA256 checksum (Linux: sha256sum, macOS: shasum -a 256)
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$ARCHIVE" > "$ARCHIVE.sha256"
else
  shasum -a 256 "$ARCHIVE" > "$ARCHIVE.sha256"
fi

echo ""
echo "✅ Backup complete."
echo "📦 Archive: $ARCHIVE"
echo "🔐 SHA256 : $ARCHIVE.sha256"
echo "📂 Contents folder: $BACKUP_DIR"
