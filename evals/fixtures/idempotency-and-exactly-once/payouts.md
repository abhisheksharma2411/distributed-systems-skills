# Partner payouts

`issue_payout` moves real money to a partner's account. The provider has no
idempotency support of its own, so a duplicate call is a duplicate transfer.

Callers that can invoke the same logical payout more than once:

- the payouts worker retries any non-2xx provider response, including timeouts
  where the transfer may already have been applied
- the queue replays its dead-letter batch each morning, up to seven days later
- two workers can pick up the same payout during a rebalance

`payout_keys` has no unique index. `partner_balances.paid_cents` is a mutable
running total, not a derived view over an entry log.
