let S = newState(parsePairConfig(args))
const hostRuntime = typeof factoryRuntime === 'undefined' ? null : factoryRuntime
S.pair = { stage: 'design', design: '', approvedDesign: '', findings: [], reviews: [], author: null,
  measurement: null, label: null, lastReview: null, signatures: [], stop: '', questions: [] }
