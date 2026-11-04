#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
git config core.hooksPath scripts/hooks
mkdir -p scripts/hooks
ln -sf ../pre-commit scripts/hooks/pre-commit
echo "hooks installed: scripts/hooks/pre-commit runs gitleaks on staged changes"
