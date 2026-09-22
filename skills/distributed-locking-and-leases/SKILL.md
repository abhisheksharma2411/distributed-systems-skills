---
name: distributed-locking-and-leases
description: Builds and reviews mutual exclusion across processes using leases, fencing tokens, and conditional writes, so that a stalled holder cannot corrupt the resource it no longer owns. Use when adding a lock around a cron job, a leader election, a singleton worker, or a shared file. Use when choosing a lease duration or a lock backend. Use when two instances of a job have both run, or a stale worker has overwritten newer state.
---

# Distributed Locking and Leases

## Overview

A lock held across a network is not a lock. It is a **lease**: permission that expires on a schedule, held by a process that may not notice it has lapsed.

The reason is one sentence long, and everything else follows from it: **you cannot distinguish a holder that is dead from a holder that is slow.** A process in a 40-second stop-the-world GC pause, a VM descheduled by its hypervisor, a container throttled to nothing by its CPU quota — all of these look exactly like a crash to the lock service, and all of them end with the process waking up and continuing as though it still held the lock. By then someone else does.

So the lock service cannot give you mutual exclusion. What it can give you is an **ordering**, and the resource itself enforces it. That is what a fencing token is, and a lease without one is advisory: it makes collisions rarer without making them impossible, which is the worst place for a correctness mechanism to sit, because the remaining rate is low enough to look like something else.

## When to Use

- Putting a lock around a cron job, batch, or migration that must not run twice
- Electing a leader, or running a singleton worker across replicas
- Coordinating writes to a shared file, object, or config blob
- Choosing a lease duration, or a backend to hold the lease in
- Investigating two instances of a job that both ran, or a stale worker that overwrote newer state
- Reviewing any code containing `SETNX`, `SET NX PX`, an advisory lock, or a lease table

**NOT for:**
- Making a single side effect safe to repeat — one atomic claim does that without a lock, and it works whether or not the lock held. See `idempotency-and-exactly-once`, which this skill depends on rather than replaces
- In-process mutual exclusion — a mutex is the right tool and none of this applies
- Transactions within one database — `SELECT … FOR UPDATE` is mutual exclusion the database can actually enforce, because it also owns the resource
- Enumerating what else breaks when the lock service is down — see `failure-mode-analysis` for the outcome table; this skill covers the lock's own behaviour under that failure

## Process

### 1. Ask whether a lock is the right tool

Most locks in production are there to prevent a duplicate effect, and for that a lock is the weaker mechanism. An atomic claim keyed on the intent is stronger: it is enforced by the resource, it has no expiry to get wrong, and it still holds when the lock service is unreachable.

| Goal | Reach for |
|---|---|
| This effect must happen at most once | An atomic claim on the intent — `idempotency-and-exactly-once` |
| This *sequence* must not interleave with another copy of itself | A lease, plus a fence at every write |
| Exactly one replica should be doing X right now | Leader election — a lease, plus a fence |
| Two writers must not clobber each other's version | A conditional write (CAS). No lock needed |

A lock wrapped around a non-idempotent effect is two bugs: the effect still duplicates when the lease lapses, and now it does so rarely enough that nobody finds it.

### 2. Pick the lease duration from the timeout you enforce

The common mistake is to measure how long the work takes and add a margin. That number describes the happy path, and the lease only matters when the path is unhappy.

```
lease ≥ (the timeout you actually enforce on the work) + (time to notice and abort)
```

If you do not enforce a timeout, you cannot pick a lease, because there is no upper bound to exceed. Enforce one first.

Short leases fail *dangerously* — they expire under a live holder. Long leases fail *slowly* — a genuinely dead holder blocks progress for the remainder of the lease. That asymmetry is the whole guidance: when in doubt, lease long and make the wait visible, because the cost of the long lease is latency and the cost of the short one is two writers.

### 3. Measure the lease on one clock, and make it the resource's

A lease is written by one host and judged expired by another. If each measures it against its own wall clock, the lease means different things to each of them.

```python
# BAD: expiry computed on the caller's clock. A host whose clock runs fast
# considers a live holder's lease expired and takes the lock while the holder
# is still working. The atomic acquire does not save you: both callers now
# believe they hold it.
expires_at = time.time() + ttl

# GOOD: the store computes it, so every host is judged against one clock
#   Postgres  ... SET expires_at = clock_timestamp() + %s::interval
#   Redis     ... SET key val NX PX 900000       (server-side TTL)
```

NTP skew of a second or two is ordinary. Minutes happen after a VM resume or with a broken time daemon, and a fifteen-minute lease does not survive a thirty-minute skew.

The same rule governs expiry checks. Comparing a stored `expires_at` against `time.time()` on the challenger's host reintroduces the skew you just removed — the comparison belongs in the same query that does the acquire.

### 4. Fence at the resource, or accept that the lock is advisory

The lock service hands out a token that only ever increases. Every write carries it. The **resource** rejects any token lower than the highest it has seen.

```python
# Acquire returns a monotonic token — a Postgres sequence, a Redis INCR, an
# etcd/ZooKeeper revision. It must come from the lock service, never from a
# clock or a local counter.
token = lock.acquire("nightly-rollup", ttl=900)

# Every write carries it, and the resource is what enforces the ordering.
db.execute(
    "UPDATE rollups SET total = %s, fence = %s WHERE day = %s AND fence < %s",
    (total, token.value, day, token.value),
)
# rowcount == 0 means a newer holder has already written. You are the stale
# one. Stop — do not retry, do not raise the fence.
```

Now the GC-paused holder wakes up and writes with token 33 while the new holder has written with 34. The row rejects it. Nothing else in the system had to be correct for that to work.

Without the fence there is no point in the lease at all beyond reducing contention. If the resource cannot carry a fence — an SMTP server, a payment provider, a third-party API — then the lock cannot make the operation safe, and the operation has to be made idempotent instead.

### 5. Make release conditional on still owning it

A release that deletes by key alone deletes whoever holds the lock now, which after an expiry is someone else.

```python
# BAD: the finally block runs after the lease expired and a second worker
# acquired it. This deletes *their* lock, and now a third worker gets in too.
finally:
    redis.delete("lock:rollup")

# GOOD: delete only if the value is still the one we wrote. Atomic, because a
# GET followed by a DEL is the same race one level down.
UNLOCK = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end"
redis.eval(UNLOCK, 1, "lock:rollup", my_token)
```

A release that returns 0 is information, not noise: it means the lease lapsed while you were working, so whatever you did during that window was unfenced. Log it with the token and treat the work as suspect.

### 6. Check the backend can actually host a lease

A lock backend needs three properties. Confirm each before choosing one, because two of the three are commonly assumed rather than checked.

| Property | Why | Check |
|---|---|---|
| Atomic conditional acquire | Two acquirers must not both win | Is it one operation? `EXISTS` then `SET` is not |
| Server-side expiry | The holder cannot be trusted to release | Does the backend expire it, or does a client? |
| A monotonic token | The fence needs an ordering the resource can compare | What increases, and can the resource see it? |

Conditional writes over object storage now cover much of this without a separate lock service:

```python
# S3: fails with 412 if the object exists or has changed
s3.put_object(Bucket=b, Key=k, Body=v, IfNoneMatch="*")
s3.put_object(Bucket=b, Key=k, Body=v, IfMatch=current_etag)

# GCS: the generation number is both the precondition and the fence
blob.upload_from_string(v, if_generation_match=current_generation)
```

The generation or ETag *is* a fence token, which is why this is often the better design: the ordering is enforced by the same system that stores the data, so there is no second system to disagree with.

A replicated cache with asynchronous failover fails the first property under failover, whatever the client library is called. If the backend can lose a recent write when a replica is promoted, two holders is a configuration change away.

### 7. Decide what happens when the lock service is down

This is a fail-open/fail-closed decision and it must be made explicitly, per operation:

- **Fail closed** — the job does not run. Safe, and it means a lock-service outage is an outage of everything the lock guards.
- **Fail open** — the job runs unlocked. Everything the lease was protecting is now unprotected, during the window when retries and restarts are most frequent.

Fail-open is defensible only where a second concurrent run is harmless, which is the same as saying the lock was not load-bearing. Whichever you choose, state it at the call site — the dangerous version is neither, where a `try/except` around the acquire silently picks fail-open on your behalf.

### 8. Treat a lost lease like an unknown outcome

If the lease expired mid-work, you do not know whether your writes landed before or after the new holder's. That is not a lock problem any more; it is a reconciliation problem, and the honest response is to record the uncertainty rather than to re-run. See `idempotency-and-exactly-once` for the unknown state and the path out of it.

## Common Rationalizations

| Rationalization | Rebuttal |
|---|---|
| "`SET NX PX` is a distributed lock" | It is a lease with no fence. It reduces overlap; it cannot prevent it. The pause that outlives the TTL is the case it was bought for, and it is the case it does not cover. |
| "We use Redlock, which is the correct algorithm" | Redlock's safety argument assumes bounded clock drift and bounded process pauses. Neither is bounded in practice, and neither failure is observable from inside the process. It still needs a fence. |
| "We heartbeat to extend the lease" | A heartbeat cannot extend a lease that has already expired, and the process that most needs to heartbeat is the one too paused to do it. Extension races expiry and loses exactly when it matters. |
| "The job takes 30 seconds and the TTL is 5 minutes" | The TTL is not racing the work, it is racing the pause. A GC pause, a throttled container, and a live migration are all uncorrelated with how long your code takes. |
| "We release in a `finally`, so it is always cleaned up" | `finally` runs whenever the process resumes, which may be after expiry. An unconditional delete then removes the *next* holder's lock. |
| "We re-check that we still hold it right before writing" | Check-then-act, one level down. The lease can expire between the check and the write. Only a fence evaluated by the resource closes that window. |
| "Two runs are harmless, it is just wasted work" | Then delete the lock and say so in the code. A lock that is not load-bearing but is treated as though it is will eventually have a real invariant hung off it by someone who trusts it. |
| "Our lock service is highly available" | Availability is not the property in question. A failover that loses the most recent acquire produces two holders on a perfectly available service. |

## Red Flags

- `SETNX`/`SET NX` acquire with a plain `DEL` release — no ownership check
- No token anywhere: the resource has no way to tell a stale writer from a current one
- A fence token derived from a timestamp, a UUID, or a per-process counter rather than from the lock service
- `expires_at` computed with the client's clock, or an expiry compared against `time.time()` on the challenger
- Lease duration justified by a measured p99 rather than by an enforced timeout
- No enforced timeout on the work the lease covers
- A lock wrapped around an effect that is not itself idempotent
- `try: acquire() except: pass` — fail-open chosen by accident
- A release whose return value is discarded, so a lapsed lease leaves no trace
- Leader election where the leader's writes carry no term or revision number

## Verification

Each of these is a test, and each fails concretely when the corresponding mechanism is removed.

1. **The paused holder is rejected.** Acquire, let the lease expire without releasing, let a second holder acquire and write, then let the first holder write. The first write must be rejected by the resource — not merely logged, not merely rare. If this test passes with the fence removed, there is no fence.
2. **Release does not steal.** Acquire, expire, let a second holder acquire, then run the first holder's release path. The second holder must still hold the lock afterwards.
3. **Skew does not grant the lock.** Move one host's clock forward by more than the lease and try to acquire. It must fail while the holder is live. This is the test that catches an expiry computed or compared on the caller's clock.
4. **Concurrent acquire has exactly one winner.** Many threads or processes, one lock, asserted on the count of winners rather than on the absence of an exception.
5. **The backend loses a write.** Kill the primary immediately after an acquire and fail over. If a second acquire then succeeds while the first holder is live, the backend cannot host this lock — that is a design finding, not a flaky test.

If you cannot point at a test that fails when the fencing check is removed from the resource's `WHERE` clause, the fence is decorative and the system is relying on the lease alone.
