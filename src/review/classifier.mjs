import { fingerprintFindings } from './findings.mjs';

export const CLEAN_SUBSTRING = "Codex Review: Didn't find any major issues.";

export function isAtOrAfter(value, lowerBound) {
  return new Date(value).getTime() >= new Date(lowerBound).getTime();
}

export function findCleanComment(comments, round, trustedActors) {
  const triggerTime = round.trigger?.created_at;
  if (!triggerTime) return null;
  return comments.find((comment) => {
    if (!trustedActors.includes(comment?.user?.login)) return false;
    if (!isAtOrAfter(comment.created_at, triggerTime)) return false;
    if (round.processedCommentIds?.includes?.(String(comment.id))) return false;
    return String(comment.body || '').trim().includes(CLEAN_SUBSTRING);
  }) || null;
}

export function collectActionableFindings({ reviews, comments, round, trustedActors }) {
  const triggerTime = round.trigger?.created_at;
  const processedReviews = new Set(round.processedReviewIds || []);
  const processedComments = new Set(round.processedInlineCommentIds || []);
  const trustedReviews = reviews.filter((review) => {
    if (!review.submitted_at) return false;
    if (!trustedActors.includes(review?.user?.login)) return false;
    if (!isAtOrAfter(review.submitted_at, triggerTime)) return false;
    if (processedReviews.has(String(review.id))) return false;
    return true;
  });
  const reviewIds = new Set(trustedReviews.map((review) => String(review.id)));
  const commitIds = new Set(trustedReviews.map((review) => String(review.commit_id || '')).filter(Boolean));
  const linkedComments = comments.filter((comment) => {
    if (processedComments.has(String(comment.id))) return false;
    if (!trustedActors.includes(comment?.user?.login)) return false;
    if (!isAtOrAfter(comment.created_at || comment.updated_at, triggerTime)) return false;
    const linked = reviewIds.has(String(comment.pull_request_review_id));
    const orphanMatch = !comment.pull_request_review_id && commitIds.has(String(comment.commit_id || ''));
    return linked || orphanMatch;
  });
  if (trustedReviews.length === 0) return null;
  return {
    reviews: trustedReviews,
    comments: linkedComments,
    fingerprint: fingerprintFindings({ reviews: trustedReviews, comments: linkedComments })
  };
}

export function updateSettlement(round, findings) {
  if (!findings) return { settled: false, round };
  const previous = round.findingsFingerprint;
  const fingerprint = findings.fingerprint;
  const quiet = previous === fingerprint && round.state === 'findings_settling';
  const nextRound = {
    ...round,
    findings,
    findingsFingerprint: fingerprint,
    state: quiet ? 'findings_collected' : 'findings_settling'
  };
  return { settled: quiet, round: nextRound };
}
