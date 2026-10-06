# Settlement fee migration

`settlements` holds roughly 240 million rows and is written to continuously by
the settlement workers — there is no window in which writes stop.

We are replacing `fee_bps` (basis points, integer) with a precomputed
`fee_cents`, because the finance exports recompute the same multiplication in
four places and two of them round differently.

The new `fee_cents` column was added nullable in last week's release. The
application was deployed on Tuesday writing **both** columns on every new
settlement: first the `INSERT` with `fee_bps`, then an `UPDATE` setting
`fee_cents`. Reads still use `fee_bps`.

`merchant_totals.fees_collected` is a mutable running total, not a view over
settlements. Finance reconciles against it monthly.

The deploy is rolling across 40 pods and typically takes 8 minutes to drain.
The last two backfills on this table were both interrupted — one by a deploy,
one by a lock timeout on the primary during peak hours.
