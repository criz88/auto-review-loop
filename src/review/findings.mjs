import { createHash } from 'node:crypto';

export function fingerprintFindings(findings) {
  const normalized = {
    reviews: [...(findings.reviews || [])]
      .map((review) => ({
        id: String(review.id),
        commit_id: String(review.commit_id || ''),
        body: String(review.body || '')
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    comments: [...(findings.comments || [])]
      .map((comment) => ({
        id: String(comment.id),
        review_id: String(comment.pull_request_review_id || ''),
        commit_id: String(comment.commit_id || ''),
        path: String(comment.path || ''),
        body: String(comment.body || '')
      }))
      .sort((a, b) => a.id.localeCompare(b.id))
  };
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

export function formatFindings(findings) {
  return {
    fingerprint: fingerprintFindings(findings),
    reviews: findings.reviews.map((review) => ({
      id: review.id,
      author: review.user?.login,
      submittedAt: review.submitted_at,
      commitId: review.commit_id,
      body: review.body || ''
    })),
    comments: findings.comments.map((comment) => ({
      id: comment.id,
      reviewId: comment.pull_request_review_id,
      author: comment.user?.login,
      createdAt: comment.created_at,
      commitId: comment.commit_id,
      path: comment.path,
      line: comment.line || comment.original_line || null,
      body: comment.body || ''
    }))
  };
}
