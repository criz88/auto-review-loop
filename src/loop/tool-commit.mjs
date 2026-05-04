export function buildToolCommitSubject(round) {
  return `Address Codex review findings (round ${round.number})`;
}

export function buildToolCommitIntent({ state, round }) {
  return {
    subject: buildToolCommitSubject(round),
    runId: state.runId || null,
    round: round.number,
    baseHead: round.localHeadBeforeRunner || null,
    findingsFingerprint: round.findingsFingerprint || null
  };
}

export function buildToolCommitMessage(intent) {
  return `${intent.subject}

Codex-Review-Loop-Run: ${intent.runId || ''}
Codex-Review-Loop-Round: ${intent.round}
Codex-Review-Loop-Base: ${intent.baseHead || ''}
Codex-Review-Loop-Fingerprint: ${intent.findingsFingerprint || ''}`;
}

export async function hasExpectedToolCommitProvenance({ git, state, round, ref, subject, expectedSubject }) {
  if (subject !== expectedSubject) return false;
  const expectedIntent = buildToolCommitIntent({ state, round });
  if (!toolCommitIntentMatches(round.toolCommitIntent, expectedIntent)) return false;
  const message = await git.commitMessage(ref);
  if (message.trimEnd() !== buildToolCommitMessage(expectedIntent)) return false;
  const parents = await git.commitParents(ref);
  return parents.length === 1 && parents[0] === expectedIntent.baseHead;
}

function toolCommitIntentMatches(actual, expected) {
  return Boolean(actual) &&
    actual.subject === expected.subject &&
    actual.runId === expected.runId &&
    actual.round === expected.round &&
    actual.baseHead === expected.baseHead &&
    actual.findingsFingerprint === expected.findingsFingerprint;
}
