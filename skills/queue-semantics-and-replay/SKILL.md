---
name: queue-semantics-and-replay
description: Consumes from brokers without losing messages, double-applying them, or wedging on one bad payload, and keeps a dead-letter replay safe weeks later. Use when writing or reviewing a consumer, choosing where to ack, or routing poison messages to a DLQ. Use when replaying a dead-letter queue. Use when messages are disappearing, arriving twice, or processing out of order after a rebalance.
---

# Queue Semantics and Replay

## Overview

A queue looks like it removes the hard parts of distributed systems and it relocates them. The broker will deliver your message; what it cannot tell you is whether your *consumer* finished with it, and every real defect here lives in that gap.

Four decisions decide whether a consumer is correct, and three of them are usually made by accident: which delivery guarantee you actually have, where the ack goes, what happens to a message that can never succeed, and whether a replay months later is safe. The last one is the one that bites hardest, because a dead-letter queue is not an error log — it is a **loaded weapon pointed at production**, and the day someone drains it is the day the retention assumptions made when the consumer was written get tested.

The framing that makes the rest follow: you cannot have exactly-once delivery, so stop designing for it. You get at-least-once delivery, and you make the duplicate harmless. Everything below is the consumer-side half of that bargain.

## When to Use

- Writing or reviewing a consumer for Kafka, SQS, RabbitMQ, Pub/Sub, NATS, or a database-backed queue
- Deciding where the ack goes relative to the side effect
- Routing poison messages, sizing a retry budget, or setting up a dead-letter queue
- **Replaying a DLQ** — the highest-risk operation in this whole area
- Investigating messages that vanish, arrive twice, or process out of order after a rebalance
- Reviewing a consumer's behaviour during a deploy or a partition reassignment

**NOT for:**
- The dedup mechanism itself — key derivation, atomic claims, the unknown state. See `idempotency-and-exactly-once`, which this skill depends on rather than duplicates. Ack-after-effect is only safe *because* that skill's machinery is in place
- Deciding retry counts and backoff for an outbound call — see `resilience-patterns`; this skill covers the broker's redelivery, not your client's
- Coordinating a singleton consumer or a leader — see `distributed-locking-and-leases`
- Broker capacity, partition counts, and throughput tuning — performance, not correctness

## Process

### 1. Write down the guarantee you actually have

Not the one on the marketing page. Three exist, and the third is usually a misreading:

| Guarantee | What it means | Cost |
|---|---|---|
| **At-most-once** | Ack first. A crash loses the message. | Silent data loss |
| **At-least-once** | Ack after. A crash redelivers. | Duplicates, which you must absorb |
| **"Exactly-once"** | Almost always broker-to-broker only | A false sense of safety |

Kafka's exactly-once semantics cover a Kafka-to-Kafka transaction: consume, transform, produce, commit offsets, all atomically **within Kafka**. The moment your consumer charges a card, sends an email, or writes to a database outside that transaction, the guarantee stops at the boundary and you are back to at-least-once. SQS FIFO deduplicates within a five-minute window, which is a deduplication *feature*, not a delivery guarantee, and five minutes is shorter than every retry chain that matters.

Write the answer in the consumer's module docstring. A consumer whose author could not say which guarantee it has is a consumer whose ack placement was chosen by whichever tutorial was open.

### 2. Put the ack after the effect, and make the duplicate harmless

This is the whole decision, and it has only one right answer:

```python
# BAD: at-most-once. The message is gone the instant it is acked, and a crash
# in `charge` loses it silently — no error, no retry, no trace.
msg.ack()
charge(msg.order_id, msg.amount)

# GOOD: at-least-once. A crash before the ack redelivers, and redelivery is
# safe because the effect is keyed.
with idempotent.claim(operation_key("charge", msg.order_id)) as claim:
    if claim.won:
        charge(msg.order_id, msg.amount)
msg.ack()
```

Acking first is chosen far more often than anyone admits, because it is what you get when you ack in a `finally`, or when the library auto-acks on delivery and nobody turned it off. **Check the default.** Auto-ack is on by default in more clients than not, and a consumer that never calls `ack()` anywhere is not a consumer with no ack — it is a consumer with at-most-once semantics nobody chose.

The window between effect and ack is where duplicates are born, and it cannot be closed — only made harmless. That is the handoff to `idempotency-and-exactly-once` and it is load-bearing: without it, ack-after-effect is just a different way to be wrong.

### 3. Know what your ordering guarantee survives

Ordering is per-partition, per-key, or absent. Nothing gives you global ordering at throughput, and code that assumes it usually works in staging with one partition.

Two failures worth expecting:

- **Rebalance mid-flight.** A partition moves to another consumer while the old one is still processing. Both may be working on the same key for a moment. Per-partition ordering does not help, because the two consumers are not coordinated — only an idempotent effect does.
- **Retry reordering.** A failed message that goes to a retry topic and comes back later has been overtaken by everything behind it. If your handler assumes "update after create", a retried create now lands after its own update.

If order genuinely matters, the fix is usually not stronger ordering but an **order-independent effect**: version numbers, a `WHERE version < :incoming` guard, or a state machine that ignores a transition it has already passed. Ordering you enforce at the broker is ordering you lose the first time something retries.

### 4. Bound the retries, then dead-letter — and watch the depth

A message that can never succeed will be retried forever, and an infinitely-retried message is not a stuck message but a stuck *consumer*: it blocks its partition, and everything behind it stops.

```
attempt 1..N  →  retry with backoff
after N       →  DLQ, with the original payload AND the failure reason
```

Two things get left out and both matter. Put the **failure reason and the attempt count** on the dead-lettered message, or whoever drains the DLQ in three weeks has a payload and no idea why it is there. And alert on **DLQ depth and the age of its oldest message**, not on the routing event — a DLQ nobody watches is a data-loss queue with extra steps, and depth alone stays flat while the oldest message quietly turns into a compliance problem.

### 5. Treat a replay as the dangerous operation it is

Draining a DLQ is a bulk re-delivery of effects that already partly happened, run by someone under time pressure, usually during an incident. It deserves a procedure:

- **Replay through the same idempotent path as live traffic.** A bespoke replay script that writes directly to the database is a second implementation of your effect, and it will not have the dedup.
- **Check key retention first.** This is the trap. If idempotency keys are kept for 24 hours and you are replaying a message from nine days ago, the key is gone, the claim succeeds, and the effect runs a *second* time — against a ledger that already has the first. Retention has to outlive the longest replay window, which is the same rule `idempotency-and-exactly-once` states from the other side.
- **Rate-limit the replay.** A DLQ drained at full speed is a self-inflicted thundering herd against the dependency that was probably the reason the messages failed.
- **Replay a single message first**, verify the effect, then the rest.

The retention question has a specific shape worth asking out loud: *what is the longest time between a message being produced and it being processed?* Not the average, not the p99 — the longest, including a DLQ that sat over a holiday weekend. Key retention must exceed that number, and almost nowhere does by default.

### 6. Make the consumer safe to deploy

A deploy is a rebalance you scheduled. During one, in-flight messages are redelivered to another consumer, so every deploy exercises the duplicate path. Handle shutdown explicitly: stop taking new messages, finish or abandon in-flight ones, and let the broker redeliver what you abandoned. Abandoning is fine. Acking on shutdown to "clean up" is data loss with a tidy log line.

## Common Rationalizations

| Rationalization | Rebuttal |
|---|---|
| "Our queue guarantees exactly-once" | It guarantees it broker-to-broker. Your card charge is not inside that transaction. The guarantee ends precisely where your side effect begins, which is the only place it was needed. |
| "SQS FIFO deduplicates for us" | Within a five-minute window, on a content hash or a dedup id you supply. Every retry chain that matters is longer than five minutes, and a DLQ replay is longer by days. |
| "We ack in a `finally` so nothing gets stuck" | That acks on failure too, which is at-most-once with extra steps. A message that failed is exactly the one you need redelivered. |
| "Duplicates are rare in practice" | They are *correlated*: deploys, rebalances, and dependency outages all produce them, and those are the same moments everything else is degraded. |
| "The DLQ is basically an error log" | An error log does not get drained into production by someone at 2am. A DLQ is queued work, and every message in it is an effect that has not happened yet. |
| "We'll replay with a script when we need to" | A script is a second implementation of your effect without the dedup. Replay through the live path or accept that you are hand-rolling idempotency under time pressure. |
| "Ordering is guaranteed, we use a partition key" | Until a retry. The retried message re-enters behind everything that overtook it, and per-partition ordering says nothing about that. |
| "We didn't add an ack, so it's at-least-once by default" | Most clients auto-ack on delivery. No ack in your code usually means at-most-once, chosen by the library on your behalf. |

## Red Flags

- `ack()` before the side effect, or anywhere in a `finally`
- Auto-ack left at its default with no comment saying the default was checked
- No dead-letter route — retries are unbounded, so one poison message can wedge a partition
- A DLQ with no alert on **depth** and **oldest-message age**
- Dead-lettered messages carrying the payload but not the failure reason or attempt count
- A replay script that calls the database rather than the consumer's own handler
- Idempotency key retention shorter than the DLQ's retention
- A handler that assumes creates arrive before updates
- Shutdown that acks in-flight messages instead of abandoning them
- No statement anywhere of which delivery guarantee the consumer has

## Verification

Each is a test, and each fails concretely when the corresponding mechanism is removed.

1. **A crash between effect and ack redelivers, and the effect happens once.** Process a message, kill the consumer before the ack, restart it. The message must be redelivered and the effect must not apply twice. This is the test that fails if the ack moves above the effect, and the one that fails if the dedup is removed — which is the point: it pins both halves of the bargain.
2. **A poison message does not wedge the partition.** Feed a message that always fails, then a good one behind it. The good one must be processed. If it is not, retries are unbounded.
3. **A dead-lettered message carries its reason.** Assert on the DLQ payload, not just on the routing.
4. **A replay after key expiry is caught.** Set key retention shorter than the replay gap and assert the duplicate is detected — by a test, in CI, rather than by a ledger. If this test cannot be written because nothing checks retention, that is the finding.
5. **A rebalance mid-flight does not duplicate the effect.** Reassign the partition while a handler is running. The effect count must not move.
6. **Shutdown abandons rather than acks.** Signal the consumer mid-message and assert the broker redelivers.

If you cannot point at a test that fails when the ack is moved above the side effect, nothing in the system is defending the placement, and it will be moved eventually by someone fixing a "stuck message" alert.
