# Finance — open questions on the merchant wallet

**Monthly close, last four months.** The sum of merchant balances has differed
from the provider statement total by: 12.--, 3.--, 41.--, 9.-- (minor units,
signs mixed). Small enough that we have been booking it as a rounding
adjustment. It has not gone away.

**Merchant 8812** asked on the 14th why their balance dropped by 240.00 with no
corresponding entry they could see. We could not tell them. There is no record
of what changed it — the dashboard shows the current number and the settlement
log has nothing on that date.

**Merchant 4417** was paid out on Tuesday and a chargeback landed on Wednesday
for a charge in that payout. Their balance is now negative. Nobody knows whether
that is allowed; the payout job skips them, so they cannot be paid again until
someone intervenes manually.

**Support** has twice re-run a refund after a timeout from the provider, to be
safe.

**Regulatory**: we must be able to explain any movement for seven years. We have
been asked informally whether we can, and have not answered.
