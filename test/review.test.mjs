import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTriggerBody, buildTriggerMarker, isAcknowledgementReaction } from '../src/review/trigger.mjs';
import { collectLateFindings } from '../src/loop/controller.mjs';
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
  assert.equal(buildTriggerBody('', buildTriggerMarker({ runId: 'run-1', round: 2 })), '@codex review\n\n<!-- prloop runId=run-1 round=2 -->');
});

test('acknowledgement requires trusted eyes reaction', () => {
  assert.equal(isAcknowledgementReaction({ content: 'eyes', user: { login: 'codex' } }, ['codex']), true);
  assert.equal(isAcknowledgementReaction({ content: '+1', user: { login: 'codex' } }, ['codex']), false);
  assert.equal(isAcknowledgementReaction({ content: 'eyes', user: { login: 'other' } }, ['codex']), false);
});

test('clean comment must be trusted and at or after trigger with exact substring', () => {
  const comments = [
    { id: 1, body: "Codex Review: Didn't find any major issues.", created_at: '2026-04-28T17:59:59Z', user: { login: 'codex' } },
    { id: 2, body: "Codex Review: Didn't find any major issues.", created_at: '2026-04-28T18:00:00Z', user: { login: 'codex' } },
    { id: 3, body: "Codex Review: Didn't find any major issues.", created_at: '2026-04-28T18:02:00Z', user: { login: 'codex' } }
  ];
  assert.equal(findCleanComment(comments, round, ['codex']).id, 2);
});

test('submitted trusted reviews and linked comments at trigger time become actionable findings', () => {
  const reviews = [
    { id: 10, state: 'COMMENTED', submitted_at: '2026-04-28T18:00:00Z', commit_id: 'abc', body: 'body', user: { login: 'codex' } },
    { id: 11, state: 'COMMENTED', submitted_at: null, commit_id: 'abc', body: 'pending', user: { login: 'codex' } },
    { id: 12, state: 'COMMENTED', submitted_at: '2026-04-28T18:01:00Z', commit_id: 'abc', body: 'untrusted', user: { login: 'other' } }
  ];
  const comments = [
    { id: 20, pull_request_review_id: 10, created_at: '2026-04-28T18:00:00Z', commit_id: 'abc', path: 'a.js', body: 'inline', user: { login: 'codex' } }
  ];
  const findings = collectActionableFindings({ reviews, comments, round, trustedActors: ['codex'] });
  assert.equal(findings.reviews.length, 1);
  assert.equal(findings.comments.length, 1);
  const first = updateSettlement({ ...round, state: 'awaiting_result' }, findings);
  assert.equal(first.settled, false);
  const second = updateSettlement(first.round, findings);
  assert.equal(second.settled, true);
});

test('approved and dismissed reviews are not actionable findings', () => {
  const reviews = [
    { id: 10, state: 'APPROVED', submitted_at: '2026-04-28T18:00:00Z', commit_id: 'abc', body: 'approved', user: { login: 'codex' } },
    { id: 11, state: 'DISMISSED', submitted_at: '2026-04-28T18:01:00Z', commit_id: 'abc', body: 'dismissed', user: { login: 'codex' } }
  ];
  const comments = [
    { id: 20, pull_request_review_id: 10, created_at: '2026-04-28T18:00:00Z', commit_id: 'abc', path: 'a.js', body: 'old inline', user: { login: 'codex' } },
    { id: 21, pull_request_review_id: 11, created_at: '2026-04-28T18:01:00Z', commit_id: 'abc', path: 'a.js', body: 'dismissed inline', user: { login: 'codex' } }
  ];

  assert.equal(collectActionableFindings({ reviews, comments, round, trustedActors: ['codex'] }), null);
});

test('late replay ignores approved and dismissed reviews', () => {
  const late = collectLateFindings({
    round: {
      ...round,
      findings: {
        reviews: [{ id: 9, state: 'COMMENTED', submitted_at: '2026-04-28T18:00:00Z', commit_id: 'abc', user: { login: 'codex' } }],
        comments: []
      }
    },
    reviews: [
      { id: 10, state: 'APPROVED', submitted_at: '2026-04-28T18:02:00Z', commit_id: 'abc', body: 'approved', user: { login: 'codex' } },
      { id: 11, state: 'DISMISSED', submitted_at: '2026-04-28T18:03:00Z', commit_id: 'abc', body: 'dismissed', user: { login: 'codex' } }
    ],
    comments: [
      { id: 20, pull_request_review_id: 10, created_at: '2026-04-28T18:02:00Z', commit_id: 'abc', path: 'a.js', body: 'approved inline', user: { login: 'codex' } },
      { id: 21, pull_request_review_id: 11, created_at: '2026-04-28T18:03:00Z', commit_id: 'abc', path: 'a.js', body: 'dismissed inline', user: { login: 'codex' } }
    ],
    trustedActors: ['codex'],
    processedReviewIds: [],
    processedInlineCommentIds: []
  });

  assert.equal(late, null);
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
