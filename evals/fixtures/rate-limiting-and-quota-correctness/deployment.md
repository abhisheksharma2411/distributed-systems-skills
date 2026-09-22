# Inference API — deployment and plan contract

**Topology.** The API runs as a Kubernetes Deployment behind an L7 load
balancer with no session affinity. Replicas: 12 steady state, HPA target 60%
CPU, scales to 40 under load. Rolling deploys, roughly four a week.

**Plan contract**, as published on the pricing page and in the signed
enterprise agreements:

| Plan | Requests / minute | Monthly spend cap |
|---|---|---|
| free | 60 | $5 |
| pro | 600 | $500 |
| enterprise | 6,000 | negotiated, per contract |

The spend cap is a hard cap: the contract says we do not bill above it, so any
usage past the cap is absorbed by us.

**Redis.** Single primary with an async replica, used for the spend counters
and for caching. It failed over twice in the last quarter; the documented
expectation is "a few seconds of unavailability, cached data may be stale".

**Known open questions.** Support has three tickets this quarter from `free`
tenants who say they were not throttled until well past 60 requests in a
minute, and finance has flagged two `pro` tenants whose usage closed the month
$40 and $120 over their cap.
