# Changelog

## 0.1.7 - 2026-05-24

- Fixed `prloop resume` so it can reclaim an inactive matching lock immediately after a manual stop when the recorded PID is no longer running.

## 0.1.6 - 2026-05-23

- Added retained-clean idempotency so `prloop run` no-ops when the current PR head already has trusted clean evidence.
- Added stale lock reconciliation for `resume` with PID, heartbeat, identity, and head checks plus audit logging.
- Documented repository guardrails for land, review monitor Human Review exits, lock recovery, and release workflow ownership.
