export function buildTriggerBody(reviewPrompt = '') {
  const suffix = String(reviewPrompt || '').trim();
  return suffix ? `@codex review ${suffix}` : '@codex review';
}

export function isAcknowledgementReaction(reaction, trustedActors) {
  return reaction?.content === 'eyes' && trustedActors.includes(reaction?.user?.login);
}
