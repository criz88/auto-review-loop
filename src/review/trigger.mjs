export function buildTriggerBody(reviewPrompt = '', marker = null) {
  const suffix = String(reviewPrompt || '').trim();
  const body = suffix ? `@codex review ${suffix}` : '@codex review';
  return marker ? `${body}\n\n${marker}` : body;
}

export function buildTriggerMarker({ runId, round }) {
  return `<!-- prloop runId=${runId} round=${round} -->`;
}

export function isAcknowledgementReaction(reaction, trustedActors) {
  return reaction?.content === 'eyes' && trustedActors.includes(reaction?.user?.login);
}
