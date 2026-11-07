# make check: everything that can be verified without a model.  make test: just the scenarios.
# `make build` regenerates plugins/dark-factory/workflows/ from src/; edit src/, never the built file.
# `make hooks` runs `make check` before each commit (there is no remote to run CI on).

NODE   ?= node
PYTHON ?= python3

.PHONY: check test logic host-test build build-check static parity unit syntax installed hooks

check: syntax build-check static parity unit logic test host-test
	@echo "check: all passed"

build:
	$(NODE) tools/build.mjs

build-check:
	$(NODE) tools/build.mjs --check

logic:
	$(NODE) --test test/logic.mjs test/pair.mjs test/improvements.mjs

test:
	$(NODE) test/sim.mjs

host-test:
	$(NODE) --test test/host-logic.mjs test/codex-runner.mjs test/codex-install.mjs test/checkpoint.mjs

static:
	$(NODE) test/static.mjs

parity:
	$(NODE) test/hash-parity.mjs

unit:
	$(PYTHON) -B -m unittest discover -s test -p 'test_*.py'

syntax:
	@for f in test/*.mjs test/fixtures/*.cjs tools/*.mjs plugins/dark-factory/lib/*.mjs plugins/dark-factory/skills/dark-factory/scripts/*.mjs plugins/dark-factory/bin/dark-factory-codex plugins/dark-factory/bin/dark-factory-evaluate; do $(NODE) --check $$f || exit 1; done
	@bash -n install-codex.sh
	@$(PYTHON) -B -c "import sys; [compile(open(f).read(), f, 'exec') for f in sys.argv[1:]]" plugins/dark-factory/bin/dark-factory $(wildcard test/*.py)
	@echo "syntax: ok"

# A plugin installed from a local folder is read from it live, so there is nothing to copy; this checks
# that the installed dark-factory is this checkout and that no pre-plugin copies shadow it.
installed:
	@status=0; \
	if ! claude plugin list 2>/dev/null | grep -q "Read from: $$(pwd)/plugins/dark-factory$$"; then echo "installed: dark-factory is not installed from $$(pwd)/plugins/dark-factory; run ./install.sh" >&2; status=1; fi; \
	for f in council factory ensemble; do \
	  if [ -e "$$HOME/.claude/workflows/$$f.js" ]; then echo "installed: stale pre-plugin copy $$HOME/.claude/workflows/$$f.js; run ./install.sh" >&2; status=1; fi; \
	done; \
	[ $$status -eq 0 ] && echo "installed: ok"; exit $$status

hooks:
	git config core.hooksPath .githooks
	@echo "pre-commit hook enabled: .githooks/pre-commit runs make check"
