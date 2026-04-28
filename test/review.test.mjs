import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTriggerBody, isAcknowledgementReaction } from '../src/review/trigger.mjs';
import { collectActionableFindings, findCleanComment, updateSettlement } from '../src/review/classifier.mjs';
import { fingerprintFindings } from '../src/review/findings.mjs';

const round = {
  trigger: { id: 1, created_at: '2026-04-28T18:00:00Z' },
  processedCommentIds: [],
  processedReviewIds: [],
  processedInlineCommentIds: []
};

test('trigger body defaults and appends focus text', () => {
  assert.equal(buildTriggerBody(), '@codex review');
  assert.equal(buildTriggerBody('for security regressions'), '@codex review for security regressions');
});

test('acknowledgement requires trusted eyes reaction', () => {
  assert.equal(isAcknowledgementReaction({ content: 'eyes', user: { login: 'codex' } }, ['codex']), true);
  assert.equal(isAcknowledgementReaction({ content: '+1', user: { login: 'codex' } }, ['codex']), false);
  assert.equal(isAcknowledgementReaction({ content: 'eyes', user: { login: 'other' } }, ['codex']), false);
});

test('clean comment must be trusted and post-trigger with exact substring', () => {
  const comments = [
    { id: 1, body: "Codex Review: Didn't find any major issues.", created_at: '2026-04-28T17:59:59Z', user: { login: 'codex' } },
    { id: 2, body: "Codex Review: Didn't find any major issues.", created_at: '2026-04-28T18:01:00Z', user: { login: 'other' } },
    { id: 3, body: "Codex Review: Didn't find any major issues.", created_at: '2026-04-28T18:02:00Z', user: { login: 'codex' } }
  ];
  assert.equal(findCleanComment(comments, round, ['codex']).id, 3);
});

test('submitted trusted reviews and linked comments become actionable findings', () => {
  const reviews = [
    { id: 10, submitted_at: '2026-04-28T18:01:00Z', commit_id: 'abc', body: 'body', user: { login: 'codex' } },
    { id: 11, submitted_at: null, commit_id: 'abc', body: 'pending', user: { login: 'codex' } },
    { id: 12, submitted_at: '2026-04-28T18:01:00Z', commit_id: 'abc', body: 'untrusted', user: { login: 'other' } }
  ];
  const comments = [
    { id: 20, pull_request_review_id: 10, created_at: '2026-04-28T18:01:01Z', commit_id: 'abc', path: 'a.js', body: 'inline', user: { login: 'codex' } }
  ];
  const findings = collectActionableFindings({ reviews, comments, round, trustedActors: ['codex'] });
  assert.equal(findings.reviews.length, 1);
  assert.equal(findings.comments.length, 1);
  const first = updateSettlement({ ...round, state: 'awaiting_result' }, findings);
  assert.equal(first.settled, false);
  const second = updateSettlement(first.round, findings);
  assert.equal(second.settled, true);
});

test('fingerprint is stable across reordered inline comments', () => {
  const a = fingerprintFindings({
    reviews: [{ id: 1, commit_id: 'c', body: 'r' }],
    comments: [{ id: 2, body: 'b' }, { id: 3, body: 'c' }]
  });
  const b = fingerprintFindings({
    reviews: [{ id: 1, commit_id: 'c', body: 'r' }],
    comments: [{ id: 3, body: 'c' }, { id: 2, body: 'b' }]
  });
  assert.equal(a, b);
});
