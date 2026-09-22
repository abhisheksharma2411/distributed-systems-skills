---
name: rate-limiting-and-quota-correctness
description: Enforces throughput limits and spend quotas that hold across every instance, and degrades deliberately when the limiter's own store is unreachable. Use when adding or reviewing a throttle, a per-tenant cap, a daily spend budget, or a 429 path. Use when choosing between fixed window, sliding window, and token bucket. Use when a limit is being exceeded in production, or a caller is being throttled who should not be.
---

# Rate Limiting and Quota Correctness

## Overview

A rate limiter is a distributed counter with a deadline, and almost every way it goes wrong is a counting problem rather than a policy problem. The limit in the config says 100 requests per second; what the system enforces is 100 × the number of instances, or 200 at a window boundary, or nothing at all for the ninety seconds the limiter's store was unreachable.

Two failures dominate, and both are quiet. The first is a **per-instance counter** behind a load balancer — the arithmetic is simple and nobody does it, so a limit written as 100 is enforced as 1,200 across twelve pods, and the only symptom is that the thing being protected falls over at a number nobody recognises. The second is the **limiter's own availability**: it sits in front of every request, so it is a new dependency on the hot path, and what happens when it is down is a decision that gets made by a `try/except` rather than by a person.

Rate limits and quotas also get conflated, and they are not the same object. A rate limit protects a *system* from load and refills continuously. A quota protects a *budget* — money, tokens, API credits — and does not refill until a period rolls over. Mixing them produces a limiter that tells a caller to retry in a second when what it means is "come back on the first of the month".

## When to Use

- Adding or reviewing a throttle, a per-tenant cap, or a concurrency limiter
- Enforcing a daily or monthly budget: spend, LLM tokens, API credits, emails sent
- Choosing between fixed window, sliding window, leaky bucket, and token bucket
- Writing the 429 path — headers, retry hints, and what the caller is expected to do
- Investigating a limit being exceeded in production, or a caller throttled who should not be
- Deciding what happens to traffic when the limiter's store is unreachable

**NOT for:**
- Deciding whether and how a *client* should retry after being throttled, including backoff and jitter — this skill covers the server side of the 429 and what it must be able to promise
- Making an effect safe to repeat when a throttled caller retries — see `idempotency-and-exactly-once`; a 429 that the caller retries is still a duplicate delivery
- Coordinating exclusive access rather than counting — see `distributed-locking-and-leases`; a limiter of one is a lock, and a lock is the better tool for it
- Capacity planning and autoscaling — a limiter enforces a number someone else chose; it does not tell you what the number should be

## Process

### 1. Decide whether it is a rate limit or a quota

They fail differently, they are refilled differently, and they usually want different status codes. Answer this first, because it determines everything downstream.

| | Rate limit | Quota |
|---|---|---|
| Protects | A system, from load | A budget: money, credits, tokens |
| Refills | Continuously | On a period boundary |
| Exceeded means | "Slow down" | "You are out until the period rolls" |
| Caller should | Retry with backoff — `429`, `Retry-After: 2` | Not retry — `402`/`403`, and tell them when it resets |
| Counter must be | Approximately right | Exactly right, and durable |

The last row is the one that costs money. A rate limiter may lose a few increments on a restart and nothing important happens. A spend counter that loses increments on a restart lets a tenant spend past their cap, and the overage is real.

A single limiter that answers both questions with the same 429 teaches callers to retry against a budget that will not refill for days.

### 2. Do the arithmetic on the per-instance counter

The default implementation of a limiter is a dictionary in process memory. Behind N instances it enforces N times the limit, and the config still says the original number.

```python
# BAD: per-instance. With 12 pods this permits 1,200/minute, not 100.
_counts = defaultdict(int)

def allow(tenant: str) -> bool:
    _counts[tenant] += 1
    return _counts[tenant] <= 100
```

This survives review because it is correct on one instance, correct in tests, and correct in staging where one pod runs. It also degrades on every deploy: rolling replacements reset the counters, so a tenant gets a fresh budget each time you ship.

A shared counter is the only version that enforces the number written in the config, and the increment must be atomic — read-then-write is the same race as a check-then-act dedup, and under exactly the load the limiter exists for:

```python
# GOOD: atomic increment, server-side expiry. The read and the write are one
# operation, so concurrent requests cannot both see the same pre-increment value.
count = redis.incr(f"rl:{tenant}:{window}")
if count == 1:
    redis.expire(f"rl:{tenant}:{window}", window_seconds)
return count <= 100
```

Per-instance limiting is defensible in exactly one case: the limit is a *local resource* guard — this pod's connection pool, this pod's memory. Then say so in the name, because `TENANT_RATE_LIMIT` is a claim about the tenant and `PER_POD_INFLIGHT_MAX` is not.

### 3. Pick the algorithm for the property you need

```
Fixed window       cheap, one counter          lets 2× through at the boundary
Sliding log        exact                       stores every timestamp; memory grows with traffic
Sliding window     near-exact, one counter     weights the previous window; the usual right answer
Token bucket       allows a controlled burst   two numbers per key; what most APIs actually want
Leaky bucket       smooths output              a queue; adds latency rather than rejecting
```

The fixed-window boundary is worth being concrete about, because it is the most common surprise: with a limit of 100/minute, a caller sending 100 requests at 12:00:59 and 100 more at 12:01:00 has sent 200 requests in one second, entirely within the limit as written. If your limit exists to protect something that cannot take 2×, fixed window does not implement it.

Burst is a separate decision from rate, and a limiter with no burst allowance rejects traffic that is within its average. Token bucket exists because "100 per second, and up to 300 at once" is a real requirement that a window cannot express.

### 4. Decide fail-open or fail-closed, per limit, in writing

The limiter's store will be unreachable at some point. There are two answers and they are both bad:

- **Fail open** — allow everything. The dependency you were protecting now takes unlimited traffic, at the moment when everything is already unhealthy and clients are retrying hardest. A limiter outage becomes an outage of the thing behind it.
- **Fail closed** — deny everything. You have caused a total outage of a healthy service, on behalf of a component that was only advisory.

The decision follows what the limit is for, and it is not the same answer for every limit in one service:

| The limit protects | Usually |
|---|---|
| A fragile downstream that falls over above the limit | Fail closed — you cannot honour the contract, so stop |
| A spend budget | Fail closed — the overage is money and it is not recoverable |
| Fairness between tenants on ample capacity | Fail open — unfairness for ninety seconds beats an outage |
| Abuse prevention on a cheap endpoint | Fail open, with a local per-instance fallback limit |

Two rules regardless of which you pick. **Never infer it from an exception** — a bare `except: return True` around the limiter check is fail-open chosen by accident, in the place you would least choose it deliberately. And **never let fail-open be silent**: emit a metric and a log line naming the limit, so the window is visible while it is happening rather than in the postmortem.

### 5. Make the limiter's own failure modes bounded

The limiter is on the hot path of every request, so it inherits the reliability requirements of everything it fronts.

- **Time it out** at a small fraction of your request budget. A limiter that hangs converts a store outage into a latency outage regardless of the fail-open decision.
- **Do not let the check double the round trips.** Pipeline the increment and the read; a limiter costing two RTTs per request has a throughput cost of its own.
- **Never make the request wait for the limiter's bookkeeping.** Sweeping expired keys, writing analytics, and updating dashboards belong off the request path.

### 6. Make the counter durable when it holds money

A quota counter that lives only in a cache is a budget that resets whenever the cache does. If exceeding the cap has a financial consequence, the increment belongs in the same durable store — and ideally the same transaction — as the thing it is counting.

```sql
-- The spend and the counter move together, or neither moves.
UPDATE tenant_budgets
   SET spent_cents = spent_cents + %s
 WHERE tenant_id = %s
   AND period = %s
   AND spent_cents + %s <= cap_cents
-- rowcount = 0 means the cap would have been exceeded. Do not proceed.
```

Checking the cap and then spending in two steps is the same race as a check-then-act dedup, with the same fix: make the condition part of the write and let the rowcount decide.

A retried request must not consume budget twice, which means the spend needs an idempotency key like any other effect — see `idempotency-and-exactly-once`.

### 7. Tell the caller something actionable

A bare 429 with no information forces every client to guess, and their guess is usually "retry immediately".

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 2
RateLimit-Limit: 100
RateLimit-Remaining: 0
RateLimit-Reset: 2
```

For a quota, say the other thing: the reset is a date, not a number of seconds, and the correct client behaviour is to stop rather than to back off. If a caller cannot tell from your response whether to retry in two seconds or on the first of the month, the response is incomplete.

Rejections must be cheap. A 429 that still queries the database has not shed the load it exists to shed.

### 8. Make it observable enough to tune

A limit nobody can see is a limit nobody will change, so it stays wrong in whichever direction it was first wrong.

Emit, per limit and per key: **headroom** (how close the top consumers are to the cap), **rejection rate**, and **fail-open seconds**. Alert on a caller sitting at 100% for a sustained period — that is either a limit set too low for a legitimate user or an abuser, and both need a human.

## Common Rationalizations

| Rationalization | Rebuttal |
|---|---|
| "The limiter is in memory, but it's close enough" | It is off by a factor of your replica count, and that factor changes when you autoscale. Write down the number it actually enforces and see whether you would have shipped it. |
| "We only run one instance" | Then the limit is correct until the first scale-out or the first rolling deploy, neither of which will be accompanied by anyone re-reading the limiter. |
| "Fixed window is fine, the boundary case is rare" | It is not rare, it is *scheduled*. Cron-driven clients cluster exactly on the boundary, which is the one moment the window permits double. |
| "If Redis is down we just allow the traffic" | That is a decision to remove the protection at the exact moment it is most needed. It may still be the right call — but it has to be written down as one, not implied by an `except`. |
| "We'll add the shared counter when it matters" | It matters the first time a tenant is billed for usage your limiter should have refused, and that conversation happens with a customer rather than in a sprint. |
| "The client will back off, they got a 429" | Only if you told them how long, and only if they implemented it. A 429 with no `Retry-After` frequently produces more load than no limiter at all. |
| "The quota is checked before we spend" | Checked and then spent is check-then-act. Two concurrent requests both check against the same remaining budget and both spend it. |
| "Rate limiting is just a thing the gateway does" | The gateway limits requests. It does not know a request costs $0.02 of inference, and a quota measured in requests does not protect a budget measured in dollars. |

## Red Flags

- A counter in a module-level dict, `lru_cache`, or instance attribute behind more than one replica
- `get` then `set`, or `read` then `incr`, as two operations
- A limit named for a tenant or an API that is actually enforced per process
- `try: … except: return True` anywhere near the limiter check
- No timeout on the limiter call
- The same 429 returned for a per-second throughput limit and an exhausted monthly budget
- A 429 with no `Retry-After` and no reset information
- A spend or token counter living only in a cache with no durable backing
- A quota checked in one statement and consumed in another
- A rejection path that is more expensive than the work it is rejecting
- No metric for how often the limiter failed open

## Verification

Each of these is a test, and each fails concretely when the corresponding mechanism is removed.

1. **The limit holds across instances.** Run the limiter from several processes or clients against one shared store and assert the total admitted equals the limit — not that each instance admitted its share. This is the test that fails immediately on a per-instance counter, and the one most often written in a way that cannot.
2. **Concurrency does not overshoot.** Fire many simultaneous requests at a limit of N and assert exactly N are admitted. A read-then-write increment passes the sequential test and fails this one.
3. **The window boundary is what you claim.** Send the full limit just before a boundary and the full limit just after, and assert the admitted count over that short span matches the algorithm you documented. If you shipped fixed window, this test should show 2× and the number should be one you accepted on purpose.
4. **The store being down does what you wrote down.** Make the limiter's store unreachable and assert the documented behaviour — allowed or denied — plus the metric that records it. A fail-open that emits nothing is indistinguishable from a limiter that is working.
5. **The quota cannot be double-spent.** Two concurrent requests against a budget with room for one. Exactly one succeeds, and the counter afterwards is exact, not approximately right.
6. **A retry does not consume budget twice.** Replay the same request with the same idempotency key and assert the counter moved once.

If you cannot point at a test that fails when the shared store is swapped for a local dictionary, the limit you are enforcing is not the limit in the config.
