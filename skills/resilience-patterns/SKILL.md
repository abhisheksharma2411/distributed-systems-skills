---
name: resilience-patterns
description: Configures timeouts, retry policy, backoff, circuit breakers, bulkheads and load shedding so one degraded dependency does not take the whole service down with it. Use when adding or tuning a retry, a timeout, or a circuit breaker. Use when picking what to shed under load. Use when a slow dependency has caused a cascading outage or exhausted a connection pool.
---

# Resilience Patterns

## Overview

Almost every cascading outage has the same shape. One dependency gets slow — not down, *slow*. Callers wait. Threads or connections pile up waiting. The caller becomes slow. Its callers wait. Somewhere near the edge a load balancer starts failing health checks on services that are perfectly healthy and simply blocked on something else. The original dependency recovers; the outage does not, because by then everyone is retrying.

Slow is worse than down, and that single fact reorders every decision here. A dependency that fails fast sheds load; a dependency that hangs *absorbs* your capacity and hands nothing back. Every pattern below exists to convert slow into fast-failed before it spreads.

One boundary matters more than the rest of the skill combined: **this skill decides whether and how to retry, and `idempotency-and-exactly-once` decides whether that retry is safe.** Applying this one without the other is not incomplete, it is how duplicate-charge incidents are manufactured. A retry policy on a non-idempotent effect is a duplication policy.

## When to Use

- Adding or tuning a timeout, a retry, a backoff or a circuit breaker
- Choosing a timeout budget for a call chain, or finding that a chain has none
- Isolating dependencies so one cannot exhaust a shared pool
- Deciding what to shed, and in what order, when load exceeds capacity
- Investigating a cascading outage, an exhausted connection pool, or a thundering herd after a recovery
- Reviewing any client configuration that has a `retries=` and no `timeout=`

**NOT for:**
- Making a retry *safe* to perform — that is `idempotency-and-exactly-once`, and this skill hands off to it at the retry step rather than restating it
- Enforcing a request budget across tenants, or shedding by quota — see `rate-limiting-and-quota-correctness`; this skill sheds to protect *this* service, that one enforces a limit someone was promised
- Coordinating a singleton or a lease — see `distributed-locking-and-leases`
- Making the system faster. These patterns cost latency and throughput on purpose

## Process

### 1. Give every call a timeout, derived from a budget

An untimed call is not "patient", it is a thread you have donated to another team's incident. Most default client timeouts are minutes or absent entirely — check rather than assume.

A timeout is not picked by feel. It comes from the caller's budget:

```
inbound request budget            3000 ms
  ├─ auth check                    200 ms
  ├─ pricing service               800 ms
  ├─ payment provider             1500 ms
  └─ headroom (serialization, GC)  500 ms
                                  ─────── must not exceed 3000
```

**The sum of the downstream budgets must be less than the caller's**, with headroom. When it is not, the caller times out first and everything still in flight is work nobody will ever read — and the downstream has no idea, so it keeps doing it. Propagate the remaining budget as a deadline (a gRPC deadline, an `X-Request-Deadline` header) so a callee that cannot finish in time can decline immediately instead of starting.

Two timeouts, not one: **connect** and **read**. A connect timeout of 30s means a dead host holds your thread for 30s before you learn anything. Connect should be short and read should be the budget.

### 2. Retry only what is transient, and only what is safe

Two independent questions, and skipping the second is the expensive mistake.

**Is the failure transient?** A 500, a connection reset, a timeout — maybe. A 400, a 401, a 422 — never. Retrying a validation error is just a slower validation error, and retrying an auth failure is how accounts get locked.

**Is the effect safe to repeat?** If the answer is no, or is "probably", stop and go to `idempotency-and-exactly-once` before writing the retry. The dangerous case is not the obvious `POST /charge` — it is the timeout, where **you do not know whether the call landed**. A timeout is not a failure; it is an unknown outcome, and retrying an unknown is exactly how one charge becomes two.

```python
# BAD: retries a timeout on a non-idempotent effect. The first charge may have
# succeeded; the client simply never heard the answer.
@retry(attempts=3)
def charge(order):
    return provider.charge(order.customer, order.total)

# GOOD: the retry is safe because the identity travels with it.
@retry(attempts=3, retry_on=(Timeout, ConnectionError, ServerError))
def charge(order):
    return provider.charge(
        order.customer, order.total,
        idempotency_key=operation_key("charge", order.id),
    )
```

Bound the attempts, and bound them by **total elapsed time** as well as count — three attempts with generous backoff can outlive the caller's whole budget, in which case attempts two and three are pure waste against a caller who has already gone.

### 3. Back off exponentially, and jitter — here is why

Backoff without jitter synchronises. Every client that failed during an outage recovered at the same moment, so they all wait 1s, then 2s, then 4s — *together*. The dependency comes back, takes a simultaneous spike of every retry in the fleet, falls over again, and now the herd is synchronised even harder by the shared second failure. The outage extends itself, and the graph looks like the dependency is flapping when the caller is doing it.

```python
# BAD: synchronised. Every client retries at exactly the same instants.
sleep(base * 2 ** attempt)

# GOOD: full jitter. Spreads the herd across the whole window.
sleep(random.uniform(0, base * 2 ** attempt))
```

Full jitter — a uniform draw across the *entire* window rather than a small wobble around the target — spreads retries best. A ±10% jitter on a synchronised fleet is still a spike, just a slightly wider one.

### 4. Break the circuit so failures cost nothing

A retry helps one request. A circuit breaker protects the *system*: once a dependency is clearly unhealthy, stop paying the timeout on every call.

Three states, and the third is the one that gets implemented badly:

- **Closed** — normal. Count failures over a rolling window.
- **Open** — fail immediately, no call made. This is the point: a fast failure costs nothing, and the dependency gets quiet time to recover.
- **Half-open** — let a *small, bounded number* of probes through. Not "the next request", and certainly not all of them — a breaker that opens fully on a timer re-herds the entire fleet the instant it closes.

Trip on **rate over a window with a minimum volume**, never on a raw count: "5 failures" trips on five out of five at 3am and never trips on 5,000 out of 100,000 at noon. And decide what you serve while open — a cached value, a degraded response, a fast 503 — because "whatever the code does when the breaker throws" is a decision too, just not one anybody made.

### 5. Bulkhead, so one dependency cannot take the pool

If every outbound call shares one connection pool or one thread pool, then the slowest dependency decides how much capacity everyone else gets. One hung integration will consume every slot, and requests that never touch it start failing.

Give each dependency its own bounded pool, sized so that **all of them saturated at once still leaves the service alive**. The test is simple to state and rarely run: hang your least important dependency and check that the most important path still serves.

### 6. Shed load before the system sheds it for you

Above capacity, something gets dropped. Either you choose, or the kernel's accept queue chooses, and it chooses by arrival order — which means it drops your health check and your payment callback with equal enthusiasm.

Shed early, at admission, where a rejection is cheap: reject a request before allocating a worker to it. Shed by *class* — health checks and callbacks last, bulk and prefetch first. And measure queue **wait time**, not queue depth: a request that has already waited past its own budget should be dropped rather than served, because serving it spends capacity on an answer nobody is still listening for.

### 7. Make degradation a decision, not an accident

Write down, per dependency: what happens when it is slow, when it is down, and when it is wrong. "The request fails" is an acceptable answer — an unexamined one is not. See `failure-mode-analysis` for the full outcome table; this step is where its answers become configuration.

## Common Rationalizations

| Rationalization | Rebuttal |
|---|---|
| "We retry on timeout, it's a transient error" | A timeout is not a failure, it is an *unknown outcome*. The call may have landed. Retrying an unknown is the duplicate-charge mechanism, and the only thing that makes it safe lives in `idempotency-and-exactly-once`. |
| "The default timeout is fine" | Most defaults are minutes or absent. Nobody chose it for your budget, and it is the single number that decides whether slow becomes an outage. |
| "Jitter is a micro-optimisation" | It is the difference between a spread-out recovery and a synchronised spike that re-downs the dependency you were waiting for. The herd is created by the backoff, not by the outage. |
| "Three retries with backoff, that's the standard" | Standard against what budget? Three attempts with exponential backoff routinely outlive the caller's deadline, so the later attempts are work for a caller who has already gone. |
| "The circuit breaker trips after 5 failures" | Five out of five at 3am trips; 5,000 out of 100,000 at noon does not. Trip on a rate over a window with a minimum volume. |
| "We have one big connection pool, it's simpler" | It is simpler until the least important dependency hangs and takes the pool with it. Shared pools couple the reliability of everything behind them. |
| "We'll add resilience when we see problems" | The problems arrive as a cascading outage during someone else's incident, which is the worst possible time to be reading client documentation. |
| "Load shedding means dropping customer requests" | So does falling over, except then you drop all of them and lose the ability to choose which. |

## Red Flags

- A client configured with `retries=` and no `timeout=`
- Any outbound call with no timeout, or a connect timeout measured in tens of seconds
- Retry logic wrapping a call whose effect is not idempotent — the highest-severity item here
- Retries on 4xx, or a retry predicate that does not name which statuses it covers
- `sleep(base * 2 ** attempt)` with no jitter
- A retry budget bounded only by attempt count, never by elapsed time
- Circuit breaker thresholds expressed as raw counts rather than rates
- Half-open that admits every waiting request at once
- One shared connection or thread pool for every outbound dependency
- No stated behaviour for what is served while a breaker is open
- Nested retries: a retrying client inside a retrying handler inside a retrying queue consumer — three layers multiply to 27 attempts

## Verification

Each of these is a test, and each fails concretely when the corresponding mechanism is removed.

1. **A slow dependency fails fast.** Inject a dependency that sleeps past the budget and assert the caller returns *within its own budget*, not when the dependency finally answers. This is the core test of the whole skill — it fails the moment a timeout is removed or set above the caller's deadline.
2. **A saturated dependency does not starve the others.** Hang the least important dependency to its pool limit and assert the most important path still serves. Fails without bulkheads.
3. **The breaker opens, and open costs nothing.** Drive failures past the threshold and assert subsequent calls return immediately *and* that the dependency received no further requests.
4. **Half-open probes are bounded.** Park many requests while open, then let the breaker go half-open, and assert only the configured number reach the dependency.
5. **Retries are bounded by time, not just count.** Assert total elapsed time across attempts stays inside the budget.
6. **Retries are not multiplied by nesting.** Count actual calls to the dependency through the whole stack. The number people expect and the number they get differ by an order of magnitude more often than not.
7. **A retried effect applies once.** Force a timeout on a call that actually succeeded downstream, let the retry happen, and assert the effect count is one. This test belongs to `idempotency-and-exactly-once` and is listed here because a retry policy without it is a duplication policy — if this test does not exist, do not ship the retry.

If you cannot point at a test that fails when the timeout is removed, nothing is defending the budget, and the first slow dependency will discover that for you.
