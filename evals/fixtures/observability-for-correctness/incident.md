# INC-104 — payout drift found at month-end close

## Summary

Finance's month-end close on 3 November did not balance. `payouts_payable` was
short by £48,210 against the ledger. Investigation found 311 payouts in state
`SENDING` with a `provider_ref` set, meaning the provider had accepted them and
our status update never landed.

The oldest was dated 6 October — 28 days before anyone noticed.

## Timeline

- **06 Oct 14:22** — first affected payout. The worker's publisher thread raised
  inside a callback and exited. The process stayed alive and kept serving the
  API.
- **06 Oct – 03 Nov** — `payout_worker_up` reported `1` throughout. Latency,
  throughput and error rate were normal. `payout_errors_total` did not move,
  because nothing raised on a request path.
- **13 Oct** — `payout_outbox_depth` rose from ~200 to ~6,100 over four days,
  then went flat. No alert exists on this metric; the panel is on the dashboard.
- **02 Nov 02:00** — nightly reconciliation ran and reported nothing. It had
  reported nothing every night since 6 October.
- **03 Nov 11:40** — finance opened a ticket.

## Questions asked in the review, not yet answered

1. Why did 28 days of drift produce no alert?
2. The reconciliation ran nightly throughout. Why did it not catch this?
3. How do we answer "when did this start" without the manual query that took
   two days to write?
