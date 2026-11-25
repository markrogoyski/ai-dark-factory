#!/usr/bin/env bash
# Link the shipped skills; the launcher resolves the full plugin through the link.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: ./install-codex.sh [--repo DIR | --user]

Install the dark-factory and groom skills for Codex. With no option, use the current Git
repository.
  --repo DIR  Install under that repository's .agents/skills directory.
  --user      Install under ~/.agents/skills for use across repositories.
  --help      Show this help without changing anything.

The skills link to this checkout. Keep it in place; rebuild with make build after editing src/.
Existing files or links to another checkout are never replaced.
EOF
}

target_repo=""
target_user=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then echo "error: --repo needs a directory" >&2; exit 1; fi
      if [ -n "$target_repo" ] || [ "$target_user" -eq 1 ]; then echo "error: choose --repo or --user once" >&2; exit 1; fi
      target_repo="$2"; shift 2 ;;
    --user)
      if [ -n "$target_repo" ] || [ "$target_user" -eq 1 ]; then echo "error: choose --repo or --user once" >&2; exit 1; fi
      target_user=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "error: unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source_skill="$here/plugins/dark-factory/skills/dark-factory"
source_groom="$here/plugins/dark-factory/skills/groom"
for executable in node python3; do
  command -v "$executable" >/dev/null || { echo "error: $executable is not on PATH" >&2; exit 1; }
done
for file in "$source_skill/SKILL.md" "$source_skill/scripts/run.mjs" "$source_groom/SKILL.md" \
  "$here/plugins/dark-factory/bin/dark-factory-codex" "$here/plugins/dark-factory/bin/dark-factory" \
  "$here/plugins/dark-factory/workflows/factory.js" "$here/plugins/dark-factory/workflows/council.js" \
  "$here/plugins/dark-factory/workflows/pair.js" "$here/plugins/dark-factory/workflows/brief.js" \
  "$here/plugins/dark-factory/workflows/run-plan.js" \
  "$here/plugins/dark-factory/lib/run-plan-runner.mjs"; do
  [ -f "$file" ] || { echo "error: incomplete dark-factory checkout: missing $file" >&2; exit 1; }
done

if [ "$target_user" -eq 1 ]; then
  skills_dir="$HOME/.agents/skills"
else
  target_repo="${target_repo:-$PWD}"
  repo_root="$(git -C "$target_repo" rev-parse --show-toplevel 2>/dev/null)" || {
    echo "error: not a Git repository: $target_repo" >&2; exit 1;
  }
  skills_dir="$repo_root/.agents/skills"
fi

# link_skill DESTINATION SOURCE: link once; never replace a file or a link to another checkout.
link_skill() {
  if [ -L "$1" ] && python3 - "$1" "$2" <<'PY'
import os
import sys
sys.exit(0 if os.path.realpath(sys.argv[1]) == os.path.realpath(sys.argv[2]) else 1)
PY
  then
    echo "already installed: $1"
  elif [ -e "$1" ] || [ -L "$1" ]; then
    echo "error: $1 already exists and points elsewhere; move it explicitly before installing" >&2
    exit 1
  else
    mkdir -p "$skills_dir"
    ln -s "$2" "$1"
    echo "installed: $1 -> $2"
  fi
}

link_skill "$skills_dir/dark-factory" "$source_skill"
# The groom skill runs the dark-factory skill's launcher, so it is linked beside it.
link_skill "$skills_dir/groom" "$source_groom"

command -v codex >/dev/null || echo "note: install and authenticate the Codex CLI before running the skill" >&2
echo 'Invoke $dark-factory or $groom in Codex. If a skill does not appear, start a new session.'
