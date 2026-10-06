# Payouts API — changes going out in this release

All four changes are in one PR, described there as "non-breaking cleanup".
CI is green and the contract tests pass.

1. **`partially_paid` added to `PayoutStatus`.** New settlement logic can now
   pay part of a batch. Purely additive to the enum.

2. **`amount` and `fee` now serialized as decimal strings** (`"12.50"`) instead
   of integer cents (`1250`). Finance asked for this — the old integers were
   being divided by 100 in five different consumers, and two of them rounded
   differently.

3. **`legacy_reference` removed from the payout response.** Our API dashboard
   shows zero requests filtering or sorting on it in the last 90 days.

4. **`DEFAULT_PAGE_SIZE` lowered from 50 to 20.** The unbounded list query was
   the top source of slow requests last quarter.

## Who calls this

- **Mobile app** (iOS and Android). Forced upgrade is not implemented. Store
  telemetry shows ~14% of active installs are on a build more than 9 months
  old; the oldest build still making requests is 17 months old.
- **Three B2B partners** on signed integration contracts. All three reach us
  through their own gateway, so their traffic arrives from one IP range and the
  dashboard aggregates it as a single caller.
- **Our own web dashboard**, deployed continuously.

The API dashboard instruments request paths and query parameters. It does not
record which fields of a response body a caller parsed.

Deploys are rolling, 20 pods, and the last three releases were rolled back at
least once.
