---
name: caching-and-staleness
description: Adds and reviews caches so they do not serve wrong answers, stampede the origin, or turn staleness into someone else's problem. Use when introducing a cache, a CDN layer, a memoized lookup, or a read replica in front of a slow read. Use when choosing a TTL or an invalidation strategy, or when deciding whether a value may be cached at all. Use when investigating a user who cannot see their own write, a thundering herd after a key expired, or a permission change that did not take effect.
---

# Caching and Staleness

## Overview

A cache is not a performance optimisation with no downside. It is a deliberate decision to sometimes serve an answer that was true a moment ago, in exchange for serving it faster. That trade is usually worth making — but it is a **correctness change**, and it is the only correctness change routinely shipped with no written statement of what it changed.

The question a cache must answer before it is added is not "how much faster is this?" It is: **how wrong may this answer be, for how long, and who agreed to that?** A cache whose staleness budget nobody can state is not tuned — it is a wager whose stake nobody has counted.

The failure that follows is rarely slowness. It is a user who cannot see the record they just created, a permission that was revoked an hour ago and still works, or an origin that falls over at the moment it is most needed because a popular key expired under load and every caller went to fetch it at once.

## When to Use

- Introducing a cache, a CDN layer, a memoized lookup, or a read replica in front of a slow read
- Choosing a TTL, or choosing between TTL, write-through, and explicit invalidation
- Deciding whether a particular value may be cached **at all**
- Reviewing a change that adds caching to an existing read path
- Investigating a read-your-own-write failure, a thundering herd, or a permission or price change that did not take effect

Not for: choosing a cache *technology*, tuning memory limits or eviction policies for capacity, or CPU-level memoization inside a single request where nothing can change underneath you.

## Process

### 1. State the staleness budget before anything else

Write down, in seconds, how out of date this value may be, and name who accepted it. If that sentence cannot be written, the cache is not ready to be added.

> `product.price` may be up to 300s stale. Accepted by pricing, 2026-09-24. A customer may be shown, and charged at, a price withdrawn up to 5 minutes ago.

The budget is not the TTL. The TTL is one mechanism for honouring it, and the true staleness is the TTL **plus** replication lag, plus the time invalidation takes to propagate, plus whatever the client caches on top. A 60s TTL behind a CDN that also caches for 60s is a 120s budget being described as 60.

State it where the decision lives — the ADR, the module docstring, the config — not in a commit message nobody reads again.

### 2. Choose invalidation, then decide what happens when it is lost

| Strategy | Staleness | Fails by |
|---|---|---|
| TTL only | Up to the TTL, always | Serving stale data for a bounded time. Simple, predictable, always slightly wrong. |
| Write-through | Near zero on the writing path | Diverging silently when a write bypasses the cache — a migration, an admin tool, another service. |
| Explicit invalidation | Near zero when it arrives | Being **unbounded** when the invalidation is lost. |

The third row is the one that gets shipped without thought. An invalidation message is a network call, so it has three outcomes, not two — and the unknown case leaves a key that is wrong until something else evicts it.

**Give explicit invalidation a TTL underneath it.** The invalidation is the fast path; the TTL is the bound on how wrong you can be when the fast path fails. Explicit invalidation with no TTL means a lost message is a permanently wrong answer with no clock running against it.

### 3. Protect the origin from your own expiry

A popular key expiring under load sends every concurrent caller to the origin at once. The cache was the only thing holding that load off, and it stops holding it at the exact moment the key is most in demand.

Coalesce: the first caller to miss recomputes, the rest wait for that result.

```python
async def get_or_compute(key: str, compute, ttl: float):
    cached = await cache.get(key)
    if cached is not None:
        return cached

    # One in-flight computation per key, per process. Waiters await the same
    # future instead of each starting their own fetch, so N concurrent misses
    # cost the origin one call rather than N.
    async with _locks[key]:
        cached = await cache.get(key)   # another waiter may have filled it
        if cached is not None:
            return cached
        value = await compute()
        await cache.set(key, value, ttl)
        return value
```

Per process. Across processes this bounds the herd to one call *per process*, not one globally — which is usually enough, and if it is not, the coordination has to move into the cache itself (a short-lived `SET NX` recompute lock). Say which of the two you chose and why; "we added coalescing" without that distinction hides a herd of one-per-pod.

Better still, recompute *before* expiry for hot keys, so no request ever waits on a cold miss. This costs recomputation of things nobody asked for, which is the right trade only for keys that are reliably hot.

### 4. Treat negative caching as a separate decision

Caching "not found" is often correct — it is what stops a scan for nonexistent keys reaching the database. It is also the most common cause of a user who cannot see their own new record: the lookup missed, the miss was cached for the same TTL as a hit, and the record created two seconds later is invisible until it expires.

Cache negatives with a **shorter** TTL than positives, and invalidate them on create. If a negative TTL is long enough that a user could plausibly create the thing inside it, it is too long.

### 5. Refuse to cache what must not be cached

Some values must not be cached at any TTL, because a stale read is not a slow answer — it is a **wrong action**:

- **Authorization decisions.** A revoked permission that still works is a security incident, not a stale read. Cache the identity, cache the role *membership* if you must, never the decision.
- **Balances and limits** that gate a spend. A stale balance authorises an overdraft.
- **Anything read to decide whether to perform an irreversible effect** — a payment, a deletion, a send.

The shape to watch for is a read whose result becomes a branch into something that cannot be undone. When you find one, the answer is not a shorter TTL. It is not caching it.

## Common Rationalizations

| Excuse | Reality |
|---|---|
| "It's only a 60-second TTL" | 60s of serving a withdrawn price, a revoked permission, or a deleted record. State what happens in those 60s; if that sentence is unacceptable, the TTL is not the problem, the caching is. |
| "We invalidate on write, so it's never stale" | Invalidation is a network call with three outcomes. Without a TTL underneath, a lost one is wrong forever. |
| "The cache is just a performance optimisation" | It changed which answers the system can return. That is a correctness change wearing a performance costume. |
| "We'll add stampede protection if it becomes a problem" | It becomes a problem at peak load, on the most popular key, when the origin is least able to absorb it. |
| "Nobody will notice a few seconds" | The one who notices is the user who just created the record and cannot see it, and they will report it as data loss. |

## Red Flags

- A cache added in a PR with no stated staleness budget, and a reviewer who approves it on latency numbers alone
- Explicit invalidation with **no TTL underneath** it
- Negative results cached with the same TTL as positive ones
- A cached value that is read to decide whether to perform an irreversible effect
- TTLs stacked at more than one layer (client, CDN, service, replica) with the budget stated as though only one existed
- "Cache invalidation is hard" used to close a discussion rather than open one about which of the three strategies is in use

## Verification

- [ ] The staleness budget is written down in seconds, with who accepted it, somewhere durable
- [ ] The stated budget accounts for every layer that caches, plus replication lag — not just this TTL
- [ ] Invalidation strategy is named, and the behaviour when invalidation is lost is bounded by a TTL
- [ ] Concurrent misses on one key cost the origin one recomputation, and whether that is per-process or global is stated
- [ ] Negative caching is either absent or has its own, shorter TTL and is invalidated on create
- [ ] No authorization decision, spend-gating balance, or pre-irreversible-effect read is served from cache
