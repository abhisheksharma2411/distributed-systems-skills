# Checkout service — SLO and dependency notes

**Inbound budget.** The edge proxy times out a checkout POST at **3 seconds**
and returns 504 to the customer. Support treats a 504 on checkout as a Sev-2.

**Dependencies, and what we know about each:**

| Dependency | Typical | Worst observed | Notes |
|---|---|---|---|
| pricing | 40 ms | 1.2 s during their deploys | deploys ~4×/week |
| payments | 300 ms | **26 s** during INC-1902 | the provider does not time out server-side |
| notify (receipts) | 90 ms | 8 s | receipts can be sent late; nobody is waiting |
| recs (upsell) | 60 ms | 15 s | decorative; the page renders fine without it |

**Payments provider.** Supports an `Idempotency-Key` header. We do not send one
today. Their docs say a request that times out client-side "may or may not have
been applied" and direct integrators to retry with the same key.

**INC-1902 (last quarter).** Pricing got slow. Checkout latency went to the
proxy timeout, then the whole service stopped answering — including `/health`,
which does not call anything. We restarted the pods and it cleared. The
follow-up action was "add retries", which is what produced the current code.

**Open question from the postmortem, never answered:** why did `/health` fail
when it has no dependencies?
