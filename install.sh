#!/usr/bin/env bash
#
# install.sh – clone lean-coffee-board to ~/repo/lean-coffee-board
#
# Usage:
#   ./install.sh
#   curl -fsSL https://raw.githubusercontent.com/pattespatte/lean-coffee-board/main/install.sh | bash
#
set -euo pipefail

REPO_URL="https://github.com/pattespatte/lean-coffee-board.git"
DEST="${HOME}/repo/lean-coffee-board"

if [ -d "${DEST}" ]; then
  echo "✗ Destination already exists: ${DEST}"
  echo "  To update an existing checkout, run:  git -C \"${DEST}\" pull"
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  echo "✗ git is required but not installed." >&2
  exit 1
fi

mkdir -p "${HOME}/repo"
echo "Cloning ${REPO_URL} → ${DEST}"
git clone "${REPO_URL}" "${DEST}"

echo
echo "✓ Installed to ${DEST}"
echo
echo "Next steps:"
echo "  cd \"${DEST}\""
echo "  # Edit js/config.js with your Supabase URL + anon key"
echo "  # Open index.html in a browser, or serve locally:"
echo "  python3 -m http.server 8000"
