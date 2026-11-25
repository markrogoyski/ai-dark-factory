// The pass's verdict: not-actionable (no outcome to deliver), needs-split (separate tickets, asked
// before any question about the bundle), needs-answers (questions only the writer can settle) or
// ready. Every verdict but not-actionable carries the ticket as it stands.
function groomResult(stopped) {
  const holder = goalHolder(S)
  const split = holder?.split || []
  if (stopped && stopped.status !== 'needs-user') return { ...stopped, verdict: stopped.status === 'not-actionable' ? 'not-actionable' : 'failed' }
  const verdict = split.length ? 'needs-split' : stopped ? 'needs-answers' : 'ready'
  const lines = [`Verdict: ${verdict}.`]
  if (split.length) lines.push(`The ticket bundles ${split.length} separate pieces of work: ${split.map(p => p.title).join('; ')}.`)
  if (stopped) lines.push(`Open questions: ${stopped.questions.map(q => `${q.id} ${oneLine(q.question, 160)}`).join('; ')}.`)
  const guidance = {
    'needs-split': 'Show the writer the pieces and offer to groom each as its own ticket. Do not hand the bundled ticket to a factory run.',
    'needs-answers': stopped?.forTheOrchestrator || '',
    ready: 'Show the ticket. It is ready to paste into Jira or save as TICKET.md, and to pass as the task of a factory, pair or council run.',
  }[verdict]
  return { ...(stopped || {}), status: stopped ? stopped.status : 'done', verdict, split, droppedDecisions: holder?.droppedDecisions || [],
    forTheOrchestrator: guidance, report: { markdown: lines.join('\n') } }
}

const pass = await guardedRun(async () => {
  if (S.raw.brief !== undefined) return groomResult(failure(S, 'failed', 'brief grooms the ticket text: pass the ticket as task, not a brief file.'))
  return groomResult(await settleGoal())
})
return withGoalBrief(S, finishRun(pass))
