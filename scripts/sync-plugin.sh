#!/usr/bin/env bash
# Copies the repo-root skill payload into plugin/ because a Claude Code plugin cannot reference files outside its own directory, so the payload must be duplicated. Run this after editing any root file.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
plugin="$root/plugin"

mkdir -p "$plugin/templates"

cp -f "$root/SKILL.md"               "$plugin/SKILL.md"
cp -f "$root/goalkeeper.workflow.js" "$plugin/goalkeeper.workflow.js"
cp -f "$root"/templates/*            "$plugin/templates/"

echo "Synced SKILL.md, goalkeeper.workflow.js, and templates/ into plugin/"
