#!/usr/bin/env bash
# Install this checkout as the dark-factory plugin. Idempotent. Re-run after editing anything under
# src/ or plugins/ (src/ is built into plugins/dark-factory/workflows/ first).
#
# Users don't need this: they run
#   /plugin marketplace add markrogoyski/ai-dark-factory
#   /plugin install dark-factory@ai-dark-factory
# This script does the same from the local checkout, so what you test is what ships.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
plugin="dark-factory@ai-dark-factory"

command -v claude >/dev/null || { echo "error: the claude CLI is not on PATH" >&2; exit 1; }

# The workflows are generated from src/: rebuild them, so an edit there can't be left out.
if command -v node >/dev/null; then
  node "$here/tools/build.mjs"
else
  echo "warning: node not on PATH; installing the workflows as committed, without rebuilding them from src/" >&2
fi
chmod +x "$here/plugins/dark-factory/bin/dark-factory"

# Registering the marketplace again refreshes it; installing an installed plugin is an update.
if claude plugin marketplace list 2>/dev/null | grep -q 'ai-dark-factory'; then
  claude plugin marketplace update ai-dark-factory
else
  claude plugin marketplace add "$here"
fi
if claude plugin list 2>/dev/null | grep -q "$plugin"; then
  claude plugin update "$plugin"
else
  claude plugin install "$plugin"
fi

# Before the plugin, install.sh copied the workflows to ~/.claude/workflows and linked ~/.claude/council
# here. Remove those, or the unprefixed /council and /factory would keep running stale copies.
[ "$(readlink "$HOME/.claude/council" 2>/dev/null)" = "$here" ] && rm "$HOME/.claude/council" && echo "removed old link ~/.claude/council"
for f in council factory ensemble; do
  old="$HOME/.claude/workflows/$f.js"
  [ -f "$old" ] && rm "$old" && echo "removed old copy $old"
done

command -v codex >/dev/null || echo "warning: codex CLI not on PATH; Codex seats will fail" >&2
command -v agy >/dev/null || echo "warning: agy (Antigravity CLI) not on PATH; Gemini seats will fail" >&2
agy_settings="$HOME/.gemini/antigravity-cli/settings.json"
if command -v agy >/dev/null && ! grep -q '"toolPermission": *"proceed-in-sandbox"' "$agy_settings" 2>/dev/null; then
  echo "warning: Gemini seats need \"toolPermission\": \"proceed-in-sandbox\" in $agy_settings" >&2
fi
command -v python3 >/dev/null || echo "warning: python3 not on PATH; bin/dark-factory needs it" >&2

cat <<'EOF'

New sessions pick up /dark-factory:factory, /dark-factory:council and /dark-factory:ensemble.
The agents call the plugin's bin/dark-factory. Allow it in ~/.claude/settings.json: this stops
them prompting mid-run, and Codex and Gemini seats need it, because neither CLI can run inside
Claude Code's sandbox and the allow rule is what lets the relay rerun them outside:
  "permissions": { "allow": [ "Bash(dark-factory:*)" ] }
EOF
