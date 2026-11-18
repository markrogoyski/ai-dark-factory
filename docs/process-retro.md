# Process retro

[Documentation index](README.md) · [Project README](../README.md)

While the workflow is being tuned, each council, factory and pair run reviews its own process
(ensemble has no retro). Turn it off with `retro: false`; in a pair run you can also use
`--no-retro` at the start of a string task or on the Codex runner's command line.

- **Notes during the run, not a retro at the end.** Every agent's output has a `process` field:
  at most two sentences on what in that turn's instructions, inputs or tools got in its way,
  naming the instruction or input, or `""`. That covers seats, checkers, the panel, relays, setup,
  question clustering, and in a pair run the author and reviewer. Claude seats are fresh agents
  each turn and wouldn't remember an earlier turn at the end.
- **One retro agent** (Sonnet) gets the notes, facts the script computed, and the report. The
  facts cover turns per role, turns that returned nothing, failed relay attempts, posts over the
  length limit, the ledger, and problems during the run. It can open the room, the Codex job logs
  and the workflow source. It weighs the notes instead of counting them, discounting requests for
  more of everything and the losing seat's complaints about scoring. It returns up to 3 things to
  keep and 3-5 concrete changes, each tied to evidence from the run.
- **Saved outside the run**, since `cleanup --all` deletes it. The agent writes `<run>/retro.md`;
  `dark-factory retro` copies it to `retros/<runId>-<repo>.md` in this repo when the plugin is
  installed from a checkout (gitignored), otherwise under `~/.claude/dark-factory/retros/`. It
  attaches the exact notes and facts, read from the retro agent's saved transcript and
  hash-checked, as `seat-run` does for relays. If the sandbox blocks the write, the agent reruns
  the command outside it, which the allow rule permits.

One note is a lead; the same note across turns or runs is a pattern. Read `retros/` across
several runs before changing anything. Transcripts still explain a failure better than any note:
a relay that mangled its prompt's indentation was found in the transcripts, and no seat's note
pointed at it.
