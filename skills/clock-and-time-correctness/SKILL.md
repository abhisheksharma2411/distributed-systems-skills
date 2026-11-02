---
name: clock-and-time-correctness
description: Reviews and writes code whose correctness depends on a clock, so that two hosts reading two different clocks cannot both believe they are right. Use when a lease, a lock, a TTL, a token expiry or a scheduled window is compared against a timestamp written somewhere else. Use when measuring a duration, ordering two events, or deciding whether something has expired. Use when investigating a lease that was reclaimed while its holder was still working, a job that ran twice at a daylight-saving boundary, or a negative latency in a metric.
---

# Clock and Time Correctness

## Overview

Almost every distributed safety property is a sentence about time. A lock is held *until*. A token is valid *for*. A claim expires *after*. Each of those sentences compares a timestamp written by one machine against a clock read by another, and the entire guarantee rests on an assumption nobody writes down: that the two clocks agree.

They do not. NTP keeps most hosts within a few milliseconds of each other most of the time, which is exactly what makes this dangerous — the assumption holds in every test, in staging, and for months in production. Then a VM resumes from a snapshot, a time daemon dies quietly, a hypervisor migrates a guest, or a container starts before NTP has stepped the clock, and one host is thirty minutes off. Every `expires_at` that host reads is now a lie, and the code does exactly what it was told.

The second half of the problem is subtler: a wall clock is not a stopwatch. `now() - started` looks like a duration and is not one, because the wall clock can be stepped backwards between the two reads. A timeout measured that way can be negative, or can be hours long, on a machine that is working perfectly.

**The defect this skill prevents is not "the clock was wrong". It is code that cannot tell the difference between a clock being wrong and an event having happened.**

## When to Use

- Writing or reviewing anything with a lease, a lock, a claim, a TTL, a token expiry, or a scheduled window
- Comparing a stored timestamp against the current time to decide whether something has expired, is stale, or may be reclaimed
- Measuring a duration, a timeout, a backoff, or a latency
- Ordering two events, or deduplicating by "most recent"
- Choosing a column type or a serialization format for a time value
- Investigating a lease reclaimed under its live holder, a job that ran twice or not at all at a daylight-saving boundary, a negative latency in a dashboard, or a token rejected as expired the moment it was issued

Not for: choosing a time library or a date-formatting convention, presentation-layer timezone display, or performance of clock syscalls.

## Process

### 1. Name which clock each timestamp came from

Before anything else, annotate every time value in the flow with its source. There are only three, and they are not interchangeable:

| Clock | What it measures | Breaks when |
|---|---|---|
| **Wall clock** (`time.time`, `now()`, `Date.now`) | A point in civil time, comparable across hosts | It is stepped, drifts, or differs from the clock that wrote the value |
| **Monotonic clock** (`time.monotonic`, `CLOCK_MONOTONIC`) | Elapsed time on *this* host | Compared against anything from another host, or persisted across a restart |
| **Logical clock** (sequence number, version, fencing token) | Order of operations, not duration | Treated as a duration, or compared across partitions that do not share the counter |

The rule that falls out: **durations use the monotonic clock, expiry uses one shared wall clock, and ordering uses a logical clock.** Most clock defects are one of these three used in another's place.

### 2. Make expiry a question for one clock, not two

A lease written by host A and checked by host B is two clocks in one comparison. The fix is not to tighten NTP; it is to remove one of the clocks.

**Have the store compute the timestamp inside the statement that uses it.** Every participant then reads the same clock, and the hosts' own clocks stop being part of the safety argument.

```sql
-- The claiming host's clock never enters the decision.
INSERT INTO claims (key, expires_at)
VALUES ($1, clock_timestamp() + ($2 || ' seconds')::interval)
ON CONFLICT (key) DO UPDATE
  SET expires_at = clock_timestamp() + ($2 || ' seconds')::interval
  WHERE claims.expires_at < clock_timestamp();
```

Note `clock_timestamp()`, not `now()`. In Postgres `now()` is the *transaction's* start time, so a claim taken inside a long-running transaction measures its lease from whenever that transaction opened — a lease that is already half spent before the effect begins.

When the store genuinely cannot do this, pass a single trusted time into the decision rather than reading the local clock at several points, so at least the comparison is internally consistent, and say in the code that this is now a trust assumption rather than a guarantee.

### 3. Assume the lease expired early, and make that survivable

Even with one clock, a lease can expire while its holder is still working — a long GC pause, a blocked syscall, or a slow downstream is enough, and no clock is wrong in that story. So expiry alone must never be the thing that makes it safe for a second holder to act.

**Pair the lease with a fencing token.** The store hands out a monotonically increasing number with each claim, and the resource rejects any write carrying a token lower than the highest it has seen. The slow original holder then fails loudly on write rather than silently racing the new one.

A lease without fencing is a performance optimisation, not mutual exclusion. It reduces contention; it does not provide safety. Say so where it is used, so the next reader does not mistake it for a lock.

### 4. Measure durations with a stopwatch, not a calendar

```python
# Wrong: the wall clock can step between the two reads.
start = time.time()
result = call()
latency = time.time() - start      # can be negative, or an hour

# Right: monotonic cannot go backwards and is not stepped.
start = time.monotonic()
result = call()
latency = time.monotonic() - start
```

This is also why a negative latency in a dashboard is a *clock* bug, not a metrics bug, and why it should be treated as a signal that durations elsewhere in the service are measured the same way.

The monotonic clock's own limit: it is meaningless across processes and across restarts. A duration that has to survive a restart has to be stored as two wall-clock points, and inherits every problem above.

### 5. Store absolute instants, and do arithmetic in UTC

- **Store an instant, not a local time.** `TIMESTAMPTZ`, epoch milliseconds, or an ISO-8601 string with an explicit offset. A naive timestamp is ambiguous for one hour every autumn and nonexistent for one hour every spring.
- **Do arithmetic in UTC, convert for display only.** "Tomorrow at 09:00" computed by adding 86,400 seconds is wrong twice a year in any zone with daylight saving.
- **A recurring local-time schedule is the exception**, and it has to be stored as a rule plus a zone (`09:00 Europe/London`), not as a materialised UTC instant — the correct UTC instant changes when the offset does, and may be a time that occurs twice or not at all.

The question that settles the format: *if this row is read in a different region, by a different service, five years from now, is there exactly one instant it can mean?*

### 6. Give every time-dependent branch a test that moves the clock

A clock bug cannot be found by a test that runs in forty milliseconds on one host. Inject the clock and drive it:

- the holder's clock is ahead of the store's by more than the lease
- the holder's clock is behind by more than the lease
- the wall clock steps backwards mid-operation
- a lease expires while its holder is still inside the effect
- an instant that falls in a repeated local hour, and one that falls in a skipped one

If the clock cannot be injected, that is the first finding, not an obstacle to reporting the rest.

## Common Rationalizations

| Claim | Why it fails |
|---|---|
| "NTP keeps the hosts in sync." | NTP is a best effort with no bound you can rely on. It also steps the clock to correct drift, which is itself the backwards jump that breaks duration measurement. |
| "The skew would have to be enormous to matter." | It has to exceed the lease, and leases are seconds to minutes. A resumed VM, a dead time daemon or a fresh container clears that easily. |
| "We'd see it in monitoring." | The host believes its own clock, so its logs are self-consistent. What surfaces is a duplicate charge or a corrupted record, days later, with nothing in it that says "clock". |
| "Both hosts are in the same datacenter." | Same room, different clocks. Physical proximity is not synchronisation. |
| "We take the maximum of the two timestamps." | That makes one host's wrong clock authoritative for everyone. It converts an occasional conflict into a permanent one. |
| "`now()` and `clock_timestamp()` are the same thing." | Not in Postgres. `now()` is fixed for the transaction, so a long transaction measures a lease from its own start. |
| "The timestamps are only for logging." | They stop being only for logging the first time someone sorts by them to decide which write won. |

## Red Flags

- A timestamp written by one host and compared against `time.time()` on another
- `time.time()`, `Date.now()` or `datetime.now()` on either side of a duration
- A lease or lock with no fencing token, described in comments as mutual exclusion
- `datetime.now()` without a timezone, or a `TIMESTAMP` column without `TZ`
- `now()` rather than `clock_timestamp()` in a Postgres claim or lease statement
- Adding 86,400 to get "tomorrow", or 3,600 to get "an hour later", in a local zone
- Ordering by `created_at` to decide which of two concurrent writes wins
- Clock values read directly from a module-level import, with no way to inject one in a test
- A clamp such as `max(0, deadline - now())` with no comment saying which impossible case it is absorbing
- A test suite with no test that moves a clock

## Verification

Before this is ready to ship:

1. **Every time value in the flow is annotated with its clock** — wall, monotonic, or logical — and none is used in another's role.
2. **Expiry is decided against one clock.** The timestamp is computed by whatever also evaluates the comparison, and the write is atomic, so no participant's local clock is part of the safety argument.
3. **A lease that expires early is survivable.** There is a fencing token, or there is a written statement that this lease is advisory and what happens when two holders act.
4. **Durations use a monotonic source**, and nothing monotonic is compared across processes or persisted across a restart.
5. **Stored instants are unambiguous** — `TIMESTAMPTZ`, epoch, or an offset-bearing string — and recurring local schedules are stored as a rule plus a zone.
6. **The clock is injectable**, and tests cover skew in both directions, a backwards step, and expiry during the effect.
7. **A failure is loud.** When skew or an expired claim is detected, the code refuses and says so, rather than continuing on an assumption it has already seen violated.

Related: `distributed-locking-and-leases` for fencing tokens and lease revalidation in depth, `idempotency-and-exactly-once` for making the duplicate harmless when a lease does fail, and `caching-and-staleness` for TTLs whose budget is about freshness rather than mutual exclusion.
