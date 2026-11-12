// runtime: "cli" (Claude Code only): one transport agent runs the whole Pair on the standalone
// runner, which resumes the author's CLI session and records exact elapsed time.
if (!S.raw.explain && transport.cli) return await pairCliRun()
return await controlledRun(async () => S.raw.explain ? explanation(S) : pairRun())
