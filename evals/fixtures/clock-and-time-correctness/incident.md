# INC-4471 — two payouts sent twice

**Status:** closed, cause not established
**Severity:** SEV-2
**Duration:** unknown; detected at reconciliation, 31 hours after the first event

## What happened

Treasury's daily reconciliation flagged two payouts with two provider
references each. Both were sent to the correct destination for the correct
amount, twice. Combined value £18,400. The provider confirmed both submissions
arrived about ninety seconds apart and that both were accepted.

Recovered by hand. The customer was not out of pocket; the company was.

## What we checked

- **The payout rows look correct.** Single row per payout, `state = 'SENT'`,
  one `reference` (the second overwrote the first), `sent_at` set.
- **The provider is not at fault.** Two distinct submissions with two distinct
  references, ninety seconds apart. Not a provider-side retry.
- **No deploy, no restart, no failover** in the window.
- **`SKIP LOCKED` is doing its job.** We reproduced the concurrent claim in
  staging with 16 workers and could not get two to claim the same row.
- **Both submissions came from real workers**, `worker-3` (eu-west) and
  `worker-6` (us-east). Both logged a successful claim for the same payout id,
  about ninety seconds apart.

## Other things noticed in the same week, not obviously related

- `payout.submit.seconds` has had a handful of **negative** values in the
  dashboard this month. Assumed to be a metrics pipeline problem; nobody has
  looked.
- The 09:00 settlement run **did not happen at all** on the last Sunday of
  October. It ran twice on the last Sunday of March. Treasury raised it; it was
  filed as a scheduler flake.
- `worker-6`'s host was migrated between hypervisors by the cloud provider nine
  days ago. We were notified after the fact.

## Follow-ups

- [ ] Add alerting on duplicate provider references
- [ ] Investigate the negative latency values
- [ ] Consider shortening `LEASE_SECONDS` so a stuck worker blocks less work
