# make (or make check): every gate that runs without a model or an installed plugin; needs only node,
# python3 and git.  make test: just the sim scenarios.  make clean: remove Python caches.
# `make build` regenerates plugins/dark-factory/workflows/ from src/; edit src/, never the built file.
# Not part of check:
#   make installed  checks, with the `claude` CLI, that the installed plugin is this checkout.
#   make hooks      sets git config core.hooksPath=.githooks in this clone (local git config, not a
#                   tracked file), so every commit runs `make check`; `make unhooks` removes it.
# NODE and PYTHON choose the interpreters that run the gates; scripts the tests start through their
# shebangs still use node and python3 from PATH.

NODE   ?= node
PYTHON ?= python3

# A git hook (and git commit from a linked worktree) exports the outer repository's index and git
# directory; the tests build their own repositories, so no recipe may inherit them. This is the
# list in GIT_REPO_ENV (plugins/dark-factory/lib/dark_factory_cli/common.py).
unexport GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY \
  GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_IMPLICIT_WORK_TREE GIT_GRAFT_FILE \
  GIT_NO_REPLACE_OBJECTS GIT_REPLACE_REF_BASE GIT_SHALLOW_FILE GIT_PREFIX GIT_CONFIG

NODE_SOURCES   = $(wildcard test/*.mjs test/fixtures/*.mjs test/fixtures/*.cjs tools/*.mjs \
                   plugins/dark-factory/lib/*.mjs plugins/dark-factory/lib/vendor/*.cjs \
                   plugins/dark-factory/skills/dark-factory/scripts/*.mjs) \
                 plugins/dark-factory/bin/dark-factory-codex plugins/dark-factory/bin/dark-factory-evaluate
PYTHON_SOURCES = plugins/dark-factory/bin/dark-factory plugins/dark-factory/lib/engine-publish.py \
                 $(wildcard plugins/dark-factory/lib/dark_factory_cli/*.py test/*.py test/fixtures/*.py)
SHELL_SOURCES  = install.sh install-codex.sh .githooks/pre-commit

.DEFAULT_GOAL := check
.PHONY: check test logic host-test build build-check static parity unit syntax installed release-check hooks unhooks clean

# The quick gates run first; then the two long ones, unit and host-test, run side by side.
check: syntax build-check static parity logic test
	@$(MAKE) --no-print-directory -j2 unit host-test
	@echo "check: all passed"

build:
	$(NODE) tools/build.mjs

build-check:
	$(NODE) tools/build.mjs --check

logic:
	$(NODE) --test test/logic.mjs test/pair.mjs test/improvements.mjs test/openrouter-logic.mjs test/handoff.mjs test/workflow-children.mjs

test:
	$(NODE) test/sim.mjs

# One node --test run, so its files run in parallel and it lasts about as long as the slowest file.
HOST_TESTS = factory-brief host-logic codex-runner codex-install checkpoint run-plan delivery-results \
  engine-identity engine-isolation engine-closure provenance policy-bundle engine-bootstrap \
  pinned-providers pinned-state pinned-delivery \
  provider-policy provider-settings provider-routing live-compatibility engine-imports \
  engine-loader-bindings engine-loader-controls engine-publication validation-overhead \
  pin-diagnostics engine-links engine-descriptors provider-refusal launch-prepare \
  openrouter-host pinned-openrouter bench usage release-check prune loader-check native-gate workflow-check candidates factory-evidence

host-test:
	$(NODE) --test $(HOST_TESTS:%=test/%.mjs)

static:
	$(NODE) test/static.mjs

parity:
	$(NODE) test/hash-parity.mjs

unit:
	$(PYTHON) -B -m unittest discover -q -s test -p 'test_*.py'

# The built workflows are parsed by `static`.
syntax:
	@for f in $(NODE_SOURCES); do $(NODE) --check $$f || exit 1; done
	@for f in $(SHELL_SOURCES); do bash -n $$f || exit 1; done
	@$(PYTHON) -B -c "import sys; [compile(open(f, encoding='utf-8').read(), f, 'exec') for f in sys.argv[1:]]" $(PYTHON_SOURCES)
	@echo "syntax: ok"

# Claude Code updates an installed plugin only when its version changes: run before tagging a release.
release-check:
	$(NODE) tools/release-check.mjs

# A plugin installed from a local folder is read from it live, so there is nothing to copy; this checks
# that the installed dark-factory is this checkout, that no pre-plugin copies shadow it, and, with one
# headless Haiku turn, that Claude Code loads every workflow. Then check native workflow behavior
# with isolated probe plugins.
installed:
	@status=0; \
	if ! claude plugin list 2>/dev/null | grep -q "Read from: $$(pwd)/plugins/dark-factory$$"; then echo "installed: dark-factory is not installed from $$(pwd)/plugins/dark-factory; run ./install.sh" >&2; status=1; fi; \
	for f in council factory ensemble; do \
	  if [ -e "$$HOME/.claude/workflows/$$f.js" ]; then echo "installed: stale pre-plugin copy $$HOME/.claude/workflows/$$f.js; run ./install.sh" >&2; status=1; fi; \
	done; \
	$(NODE) tools/loader-check.mjs || status=1; \
	$(NODE) tools/workflow-check.mjs || status=1; \
	[ $$status -eq 0 ] && echo "installed: ok"; exit $$status

# Changes this clone's git config, not a tracked file. Refuses to replace another hooks path.
hooks:
	@current=$$(git config --get core.hooksPath); \
	if [ -n "$$current" ] && [ "$$current" != .githooks ]; then echo "hooks: core.hooksPath is already $$current; not changing it" >&2; exit 1; fi
	git config core.hooksPath .githooks
	@echo "hooks: on; each commit runs make check (git commit --no-verify skips it once, make unhooks turns it off)"

unhooks:
	@current=$$(git config --get core.hooksPath); \
	if [ "$$current" = .githooks ]; then git config --unset core.hooksPath && echo "hooks: off"; \
	elif [ -n "$$current" ]; then echo "unhooks: core.hooksPath is $$current, not set by make hooks; leaving it" >&2; exit 1; \
	else echo "hooks: already off"; fi

# The live plugin's package digest covers every file under plugins/dark-factory, caches included.
clean:
	find plugins test tools -name __pycache__ -type d -prune -exec rm -rf {} +
	rm -rf .pytest_cache
