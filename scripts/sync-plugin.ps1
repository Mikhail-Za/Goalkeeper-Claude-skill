# Copies the repo-root skill payload into plugin/ because a Claude Code plugin cannot reference files outside its own directory, so the payload must be duplicated. Run this after editing any root file.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$plugin = Join-Path $root "plugin"

New-Item -ItemType Directory -Force -Path (Join-Path $plugin "templates") | Out-Null

Copy-Item -Force (Join-Path $root "SKILL.md")               (Join-Path $plugin "SKILL.md")
Copy-Item -Force (Join-Path $root "goalkeeper.workflow.js") (Join-Path $plugin "goalkeeper.workflow.js")
Copy-Item -Force -Recurse (Join-Path $root "templates\*")   (Join-Path $plugin "templates")

Write-Host "Synced SKILL.md, goalkeeper.workflow.js, and templates/ into plugin/"
