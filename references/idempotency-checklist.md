# Idempotency review checklist

The pre-merge gate for any change that charges, refunds, pays out, sends, decrements, or otherwise produces a side effect that a retry could repeat. Extracted from [`idempotency-and-exactly-once`](../skills/idempotency-and-exactly-once/SKILL.md), which carries the process behind each item — this file is the artifact you take to a code review, a design review, or a pre-merge gate.

Every item is answered **yes, with evidence** or **no**. "Considered", "should be fine", and "the framework handles it" are not answers. Each item names the evidence to point at; if it does not exist, the answer is no.

- [ ] **1. Replay** — Does invoking the handler twice with the same key, concurrently, produce exactly one effect and identical responses?
  *Evidence:* a test that asserts one effect and identical responses — and fails when the idempotency logic is removed.

- [ ] **2. Crash** — If the process is killed between the effect and the outcome write, does a restart produce no second effect?
  *Evidence:* a test that aborts between effect and outcome-write and asserts no second effect on replay.

- [ ] **3. Divergence** — Does the same key with a different payload fail loudly, rather than returning the first attempt's cached response?
  *Evidence:* a test asserting an explicit error (e.g. 422) on key reuse with a changed request hash, not a 2xx with a stale body.

- [ ] **4. Concurrency** — Do N parallel calls with one key produce one winner, N−1 conflicts, and zero extra effects?
  *Evidence:* a test that fires N concurrent requests and asserts an effect count of exactly one.

- [ ] **5. Constraint** — Does the unique index on the idempotency key exist in the migration, not just the model?
  *Evidence:* the migration (or the live schema) showing the unique index on the dedup store's key column.

- [ ] **6. Retention** — Is the key TTL at least as long as the longest possible retry chain, including DLQ replay and provider dispute windows?
  *Evidence:* the configured TTL, shown side by side with the DLQ replay window and the dispute window it must exceed.

- [ ] **7. Observability** — Are `duplicate_suppressed_total`, `unknown_state_total`, and `oldest_unreconciled_age` emitted, with an alert on `oldest_unreconciled_age`?
  *Evidence:* the emission in code and the alert rule — on staleness, not just count, because a stuck reconciliation is invisible in a count that stays flat.
