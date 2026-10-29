---
name: multi-region-and-replication-lag
description: Designs and reviews reads, writes and failover across regions so lag does not surface as a missing record, a reversed order of events, or a write lost in a promotion. Use when routing reads to a replica or a secondary region, when adding an active-active or active-passive deployment, or when writing a runbook for regional failover. Use when investigating a user who cannot find what they just created, a webhook that arrived before the row it refers to, or records that vanished after a failover. NOT for choosing a TTL or an invalidation strategy for a cache, and NOT for the single-region question of which isolation level a transaction needs.
---

# Multi-Region and Replication Lag

## Overview

A read replica is usually added for capacity and described as a performance change. It is not. It introduces a second copy of the truth that is *behind* the first by an amount nobody has bounded, and it makes available a class of answer the system could not previously give: **a confidently wrong one, about the recent past.**

The defect this produces is almost never reported as lag. It is reported as data loss. A user creates a record, the write goes to the primary, the redirect goes to a replica that has not seen it, and the application says the record does not exist. The user believes their work was lost — and from where they stand that is exactly what happened.

Lag is not the only cost, and not the worst one. The worst one is **failover**, where lag stops being a delay and becomes a decision: promote a secondary that is behind, and the writes it never received are gone. That decision is almost always made at 3am by whoever is on call, which means it must be made in advance, in writing, by someone who was not panicking.

## When to Use

- Routing reads to a read replica, a follower, or a secondary region
- Adding a second region, in either active-passive or active-active shape
- Writing or reviewing a regional failover runbook, or a promotion procedure
- Reviewing a change that moves a read off the primary
- Investigating a read-after-write failure, an out-of-order event, or records missing after a failover or promotion
- Deciding where a given write must land when the user, the data and the compute are in three different places

Not for: choosing a database or a replication technology, tuning replication throughput, cache TTLs and invalidation, or single-region transaction isolation.

## Process

### 1. Classify every read before routing any of it

There are only three kinds of read, and the mistake is treating them as one.

| Kind | May be served by | Because |
|---|---|---|
| **Read-your-writes** — the caller is reading something they just changed | Primary, or a replica proven to have the write | Staleness reads as data loss to the one person who knows it exists |
| **Monotonic** — the caller will read this repeatedly | One replica, pinned | Different replicas are at different offsets; round-robin makes time run backwards |
| **Lag-tolerant** — a dashboard, a report, a list someone browses | Any replica | Nobody can tell, and nobody is owed a guarantee |

Route by this table, not by endpoint. The same `GET /orders/{id}` is the first kind immediately after a checkout and the third kind when it arrives from a bookmark two days later.

### 2. Make read-your-writes a mechanism, not an intention

"Read from the primary after a write" is a convention, which means it holds until the next person adds a code path. Make it something the code carries:

- **Write token.** The write returns its replication position; the read passes it back and the router waits for a replica that has reached it, or falls through to the primary. The only approach that survives a reorganised codebase, because the requirement travels with the request.
- **Sticky session for a bounded window.** Pin the caller to the primary for N seconds after any write. Cheap, and wrong at the edges — N is a guess, and lag does not respect it.
- **Read the primary for this entity.** Narrow and honest, and it degrades the moment someone adds a second read path for the same entity.

Whichever you choose, write down which reads are covered. An uncovered read is not a bug that shows up in tests; it shows up as a support ticket about a missing record.

### 3. Bound the lag, then alarm on it in time units

Lag measured in bytes or in log positions cannot be reasoned about by anyone deciding whether to promote. Export it in **seconds**, and alarm on the number that would actually matter during an incident.

The number to watch is not the mean. It is the **maximum across replicas**, because a single stalled follower that is still in the read pool serves every one of its queries from the far past, and an average over twelve healthy replicas hides it completely.

Also alarm on lag that is suspiciously *low*. A replica reporting zero lag is sometimes caught up and sometimes disconnected and reporting the age of a stream that stopped moving.

### 4. Decide the failover trade before the failover

Promoting a replica that is behind discards every write it never received. That is sometimes the correct choice — a payments API that is down is also losing money — but it is a **business decision about losing acknowledged writes**, and it must be made with the number in front of you.

Write the runbook as a threshold, not as a judgement call:

> Promote if lag < 5s. Between 5s and 60s, page the on-call director; the orders accepted in that window must be reconciled from the gateway before we take traffic. Over 60s, do not promote: stay down and recover the primary.

Then decide what happens to the writes that were lost, because "they are gone" is not an answer when they were payments. If the acknowledged write exists anywhere else — a gateway, a queue, an upstream ledger — the runbook names that source and the procedure for replaying from it.

**Never promote automatically on a health check alone.** A network partition looks exactly like a dead primary from one side, and an automatic promotion during one gives you two primaries taking writes.

### 5. Treat active-active as a conflict problem, not a routing problem

Two regions taking writes for the same entity will eventually take conflicting ones. The question is not whether, but what the system does about it — and the default answer is usually the worst one available.

**Last-write-wins by wall clock silently discards data.** Clocks between regions disagree by more than the window in which two conflicting writes occur, so the write that survives is the one whose host had the faster clock, not the one that happened later. Nothing logs this. The record simply holds one of the two values.

The shapes that actually work:

- **Partition ownership.** Every entity has one home region that owns its writes; other regions forward. No conflicts, at the cost of cross-region latency for away writes.
- **Commutative structures.** Counters, sets and other CRDTs merge without a loser, for data that fits.
- **Explicit conflict records.** Keep both, mark the conflict, let a human or a rule resolve it. The only option that cannot lose a write silently.

If the answer is last-write-wins, say so where the data model is defined, and say what it costs.

### 6. Expect the notification to beat the data

Cross-region replication of your database and a webhook or event sent directly from the writing region are two independent paths, and the short one wins. The consumer gets "order 123 is ready", looks up order 123 in its local replica, and finds nothing.

Never treat a lookup miss here as "does not exist". It is "not here yet". Carry the data in the event where it is small enough, or have the consumer retry the read with backoff — and have the retry read the primary once the delay stops being plausible.

## Common Rationalizations

| Excuse | Reality |
|---|---|
| "Replication lag is only a few milliseconds" | That is the mean on a healthy day. The defect happens on the slow one, and the user hit by it sees a missing record, not a slow one. |
| "We read from the primary after a write" | A convention, not a mechanism. It held until someone added the second read path, and nothing failed when they did. |
| "Failover is automatic, so we're covered" | Automatic promotion during a network partition gives you two primaries. Covered against a dead host, exposed to a split brain. |
| "Last-write-wins is fine for this field" | Then say which write loses, and confirm it is being chosen by a trustworthy clock rather than by whichever host drifted ahead. |
| "We'll just promote the replica if the region goes down" | Promoting a replica that is 40 seconds behind discards 40 seconds of acknowledged writes. Name the threshold and who may approve crossing it. |
| "The event carries the ID, the consumer can look it up" | Across regions the event arrives first. The lookup misses, and the consumer decides the entity does not exist. |

## Red Flags

- A read routed to a replica with no statement of which of the three kinds it is
- Replication lag monitored as a mean, or in bytes, rather than as a maximum in seconds
- A failover runbook that says "promote the replica" with no lag threshold and no named approver
- Automatic promotion triggered by a health check that cannot distinguish a partition from a failure
- Last-write-wins on a field that two regions can both write, with no statement of the clock it trusts
- A cross-region consumer that treats a lookup miss as "does not exist" rather than "not yet"
- A stalled replica that stays in the read pool because the health check only tests that it answers queries
- "Eventually consistent" used to close a question about how long eventually is

## Verification

- [ ] Every replica-served read is classified read-your-writes, monotonic, or lag-tolerant, and routed accordingly
- [ ] Read-your-writes is enforced by a mechanism that travels with the request, not by a convention a new code path can miss
- [ ] Repeated reads by one caller cannot go backwards in time — the replica is pinned, or the offset is carried
- [ ] Lag is exported in seconds, alarmed on the maximum across replicas, and a stalled replica leaves the read pool
- [ ] The failover runbook states a lag threshold, who approves crossing it, and where lost writes are recovered from
- [ ] Promotion cannot be triggered automatically by a signal that a network partition would also produce
- [ ] For any entity two regions can both write: ownership, a commutative type, or a conflict record — and not an unexamined last-write-wins
- [ ] Cross-region consumers retry a missing referent rather than concluding it does not exist
