---
name: distributed-data-consistency
description: Keeps state agreeing across services that share no transaction, using outbox publishing, compensating sagas and business-invariant monitoring. Use when one handler writes to a database and also publishes an event, calls another service, or updates a cache. Use when designing a multi-step workflow that can fail halfway. Use when two systems disagree about the same fact and nobody knows which is right.
---

# Distributed Data Consistency

## Overview

The defect that produces most cross-service drift is two lines of code that both look fine:

```python
order.save()                       # committed
events.publish("order.paid", ...)  # may not happen
```

That is a **dual write**, and it is invisible in testing because both calls succeed on a healthy machine. In production the process dies between them, or the broker is briefly unreachable, and the database now believes something the rest of the company never hears about. Nothing errors. The order is paid and will never be fulfilled, and you find out when a customer asks.

There is no way to make two systems commit atomically without a transaction spanning both, and you do not have one. So the goal is never "keep them in sync" — it is to make the disagreement **bounded, detectable, and self-correcting**. Every technique here is one of those three: the outbox bounds it, invariant monitoring detects it, compensation corrects it.

The uncomfortable part, and the reason this skill exists separately from the others: consistency here is a *property of the whole flow*, not of any one service. You cannot review it by reading one repository.

## When to Use

- A handler that writes to a database and also publishes an event, calls another service, or invalidates a cache
- Designing a multi-step workflow that can fail after step two of four
- Deciding what a caller may assume immediately after a write returns `200`
- Two systems disagreeing about the same fact, and nobody being sure which is authoritative
- Adding a read replica or a cache in front of something that is written elsewhere
- Any review where "and then we publish an event" appears after a `commit`

**NOT for:**
- Making one individual step safe to repeat — that is `idempotency-and-exactly-once`, and every compensation and every redelivery here depends on it
- Consuming from the broker once the event exists: ack placement, poison messages, DLQ replay — see `queue-semantics-and-replay`. This skill covers getting the event *published* at all
- Deciding retry counts, timeouts and breakers for a cross-service call — see `resilience-patterns`
- Mutual exclusion or leader election around a workflow — see `distributed-locking-and-leases`
- Ledger-specific rules: double-entry, settlement, disputes. Those are their own domain

## Process

### 1. Find the dual write

Look for a commit followed by anything that leaves the process. It is the most common source of drift and the easiest to miss, because both halves have their own error handling and neither is obviously wrong.

```python
# BAD: two systems, no shared transaction. A crash between them is silent.
with db.transaction():
    order.status = "paid"
    order.save()
events.publish("order.paid", order.id)     # ← may never run

# BAD: the same defect wearing a different hat
with db.transaction():
    order.save()
    cache.delete(f"order:{order.id}")      # ← succeeds, then the tx rolls back
```

The second is worth staring at. The cache delete happens *inside* the transaction and therefore happens even when the transaction rolls back — the write is undone and the cache is invalidated anyway. Harmless there; the mirror case, populating a cache inside a transaction that then rolls back, caches a value that never existed.

Reordering does not fix a dual write. Publishing first and committing second turns "committed but never published" into "published but never committed", which is worse: consumers act on an order that does not exist.

### 2. Eliminate it with an outbox

Write the intent and the event **in the same transaction**, to the same database. Publish from the table afterwards.

```python
with db.transaction():
    order.status = "paid"
    order.save()
    outbox.insert(topic="order.paid", payload={...}, key=order.id)
# a separate relay reads the outbox and publishes, marking rows as sent
```

Now there is one commit, so there is no window. The relay may publish the same row twice — it crashes after publishing and before marking — which is fine and expected: at-least-once, absorbed by the consumer, which is why this skill depends on `idempotency-and-exactly-once` rather than restating it.

Three things people get wrong:

- **The relay must be the only publisher.** A handler that also publishes directly for "urgent" events has reintroduced the dual write next to the mechanism that removed it.
- **Order per key, not globally.** Publish in insertion order *within a partition key*, or a status update overtakes the creation it describes.
- **The outbox needs its own alerting.** Unsent rows older than a threshold means the relay is dead, and the system looks healthy from every other angle — the database is fine, the broker is fine, and nothing is being published.

### 3. Design sagas as forward steps plus explicit compensations

Once a flow spans services, there is no rollback. There is only doing something else that makes the outcome acceptable.

```
reserve inventory  →  charge card  →  create shipment
     ↓ fail             ↓ fail            ↓ fail
      —            release inventory   refund + release
```

Write the compensation table before writing the happy path. It is the artefact that makes the design reviewable, and the step whose compensation you cannot name is the step that will strand state.

Rules that hold every time:

- **Compensations must be idempotent.** They run from a retry, and the retry has no idea whether the first attempt landed.
- **Some steps cannot be compensated.** A sent email is sent. Order the flow so irreversible steps come *last*, after everything reversible has succeeded.
- **A compensation can fail too.** That is not a bug to retry forever; it is a state for a human, and it needs a queue with an owner and an alert on its age.
- **Do not model a saga as a transaction.** Naming it `rollback()` invites the assumption that afterwards nothing happened. Something happened, then something else did.

### 4. State read-after-write expectations in the contract

A caller who reads immediately after a write and gets stale data will either add a `sleep` or file a bug. Both are your fault if the contract never said.

Decide per endpoint and write it down:

- **Read-your-writes** — the caller sees their own write immediately. Costs a primary read or a session-pinned replica.
- **Eventually consistent, bounded** — "visible within N seconds". Publish N and alert on it, or it is a wish.
- **Return the state you wrote.** Often the cheapest fix: the response carries the new value, and the caller has no reason to re-read.

If a write returns `202` and a status URL, that is not a worse API than one returning `200` with stale data — it is an honest one.

### 5. Monitor business invariants, not infrastructure

Infrastructure metrics tell you the service is up. They do not tell you that `orders paid but never fulfilled` has been climbing for two days.

An invariant is a query, a threshold, and an alert:

```
orders paid but not fulfilled, older than the fulfilment SLA        = 0
outbox rows unsent for longer than the relay's polling interval × 5 = 0
inventory reserved with no active order                             = 0
shipments created for orders that were refunded                     = 0
```

Alert on the **age of the oldest violation**, not the count. A stuck relay produces a count that stops growing once the backlog stabilises, while the age climbs forever — and the count-based alert stays quiet the whole time.

These are also the only honest way to answer "are we consistent right now?". Writing them is how you discover the two services never agreed on what "fulfilled" means.

### 6. Decide which system is authoritative, per fact

Drift is only resolvable if one side wins by rule rather than by whoever wrote last. Write the table:

| Fact | Authoritative | Everyone else holds |
|---|---|---|
| Was the card charged | the payment provider | a cached local view |
| What the customer ordered | the order service | a denormalised copy |
| Is the item in stock | the inventory service | a best-effort estimate |

A reconciliation job without this table cannot do anything but report that the numbers differ.

## Common Rationalizations

| Rationalization | Rebuttal |
|---|---|
| "We publish the event right after the commit, it is fine" | That gap is the entire defect. It is small, uniformly distributed over every deploy and every crash, and invisible in every test you will write for it. |
| "We use a transactional message broker" | Transactional *within the broker*. Your database commit is not in that transaction, which is precisely the boundary the dual write straddles. |
| "We'll publish first, then commit" | Now consumers act on an order that does not exist. You have swapped a missing event for a phantom one. |
| "Two-phase commit solves this" | It requires every participant to support it, blocks on the coordinator, and most of your participants are HTTP APIs. This is why the outbox exists. |
| "Eventual consistency means it sorts itself out" | It means it converges *if something converges it*. Without a relay, a reconciliation job, or a compensation, "eventual" is "never" with better marketing. |
| "The saga rolls back on failure" | Nothing rolls back. A compensating action runs, which is a new forward action with its own failure modes. |
| "We'd notice if orders were stuck" | You would notice a spike. A slow leak of 3 a day is invisible for months and is exactly what these bugs produce. |
| "Adding an outbox is over-engineering for one event" | The outbox is roughly one table and one relay. Finding out which orders were paid but never fulfilled, six months later, is not. |

## Red Flags

- A `commit()` followed by `publish()`, an HTTP call, or a cache write
- A cache invalidation or population *inside* a database transaction
- Any event published from more than one place, once an outbox exists
- An outbox with no alert on the age of its oldest unsent row
- A multi-step cross-service flow with no written compensation per step
- A compensation that is not idempotent, or that cannot itself fail safely
- An irreversible step (email, payout, SMS) ordered before a reversible one
- `rollback()` naming a compensation
- An API contract that says nothing about read-after-write visibility
- Monitoring that is entirely infrastructure metrics, with no business invariant
- A reconciliation job that reports differences without a rule for which side wins

## Verification

Each is a test, and each fails concretely when the corresponding mechanism is removed.

1. **Kill between the commit and the publish.** The event must still be delivered. This is the test that fails the moment someone "optimises" the outbox away, and the one that proves the relay exists at all.
2. **Kill the relay after publishing, before marking sent.** The row republishes and the consumer absorbs the duplicate. Asserts the at-least-once bargain is actually held on both sides.
3. **Fail step three of four.** Assert the compensations for steps one and two ran, and that running them twice leaves the same state.
4. **Run a compensation twice.** Same end state. If it is not idempotent it will pass once and corrupt on the retry, which is the order these bugs surface in.
5. **Assert every invariant is zero, in CI, against a seeded database.** Seed a violation and confirm it fails — an invariant query that cannot fire is the same as no invariant.
6. **Stop the relay and let the clock move.** The oldest-unsent-row alert must fire. A metric nobody has ever seen fire is a metric nobody knows the shape of.

If you cannot point at a test that fails when the outbox insert is replaced by a direct publish, nothing in the system is defending the property, and the next person to touch that handler will inline the publish for good reasons.
