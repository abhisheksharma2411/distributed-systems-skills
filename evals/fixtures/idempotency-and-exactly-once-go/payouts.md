# Partner payouts

`ProcessPayout` moves real money to a partner's account. The provider has no
idempotency support of its own, so a duplicate call is a duplicate transfer.

The payouts worker calls `ProcessPayout`, whose loop retries returned errors,
including provider timeouts where the transfer may already have been applied.
The queue also replays its dead-letter batch each morning, up to seven days
later. Two workers can pick up the same payout during a rebalance.

`payout_keys` has no unique index. `partner_balances.paid_cents` is a mutable
running total, not a derived view over an entry log.
