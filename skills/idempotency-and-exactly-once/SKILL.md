---
name: idempotency-and-exactly-once
description: Designs and reviews side-effecting operations so that retries, replays, and concurrent duplicates produce exactly one effect. Use when writing or reviewing code that charges money, sends messages, mutates inventory, or calls a non-transactional external API. Use when adding retries, queue consumers, webhooks, or agent tool calls that mutate state. Use when investigating duplicate charges, double-sent notifications, or drifted balances.
---

# Idempotency and Exactly-Once Effects

## Overview

Every network call has three outcomes, not two: success, failure, and **unknown**. The unknown case — a timeout, a dropped connection, a process killed mid-write — is the one that creates duplicates, because the only safe response to "unknown" is to retry, and a retry of an already-applied operation applies it twice.

"Exactly-once delivery" does not exist. What is achievable is **at-least-once delivery with idempotent processing**, which produces exactly-once *effects*. This distinction is the entire skill: you cannot stop the duplicate from arriving, so you must make the duplicate harmless.

This matters most where the effect is irreversible or externally visible: money moves, an email sends, inventory decrements, a webhook fires. Duplicates in these paths are not a latency bug — they are a correctness bug that reaches customers, and they are usually discovered by finance rather than by monitoring.

## When to Use

- Writing or reviewing any handler that charges, refunds, pays out, or transfers
- Adding a retry, backoff, or circuit breaker to a call that mutates state
- Building queue consumers, webhook receivers, or cron/batch jobs that reprocess
- Exposing an agent tool that performs a real-world side effect
- Investigating duplicate charges, double notifications, or reconciliation drift
- Designing an API that clients will call over an unreliable network

**NOT for:**
- Read-only endpoints and pure functions — naturally idempotent, no key needed
- Deciding *whether* to retry and with what backoff — that's a resilience/retry-policy concern; this skill covers making the retry safe once you've decided to make it
- General observability and alerting — see `observability-and-instrumentation`; this skill defines *what* to measure (duplicate rate, ledger drift)
- Keeping two services consistent without a shared transaction (sagas, transactional outbox, compensations) — that's a broader consistency problem; this skill covers making each individual step safe to repeat, which those patterns depend on

## Process

### 1. Classify the operation

Not everything needs a key. Classify first, because unnecessary idempotency machinery is its own source of bugs.

| Class | Example | Treatment |
|---|---|---|
| **Naturally idempotent** | `SET status = 'shipped'` | Nothing needed |
| **Idempotent if keyed** | `charge($50)`, `send_email()` | Requires an idempotency key |
| **Accumulative** | `balance += 50`, `INSERT` into a log | Requires a key **and** a dedup store — the most dangerous class |
| **Non-reversible external** | Third-party payout, SMS | Key + provider-side idempotency + reconciliation |

The accumulative class is where most production duplicate bugs live, because the naive implementation looks correct and passes every test that doesn't simulate a retry.

### 2. Derive the key from the intent, not the attempt

The idempotency key must be stable across retries of the same logical intent and different across distinct intents. This is where most implementations go wrong.

```python
# BAD: new key per attempt — every retry is a new charge
key = uuid4()

# BAD: not unique per intent — two legitimate $50 charges collapse into one
key = f"{user_id}:{amount}"

# BAD: derived from mutable state — key changes if the cart is edited mid-retry
key = hash(cart.contents)

# GOOD: caller-supplied, stable per business intent
key = request.headers["Idempotency-Key"]          # client generates once, reuses on retry

# GOOD: derived from an immutable upstream identifier
key = f"charge:v1:{order_id}:{payment_attempt_id}"
```

Rules that hold in every system:
- The **client** or the **initiating event** owns the key, never the retrying layer
- Version the key format (`charge:v1:...`) so you can change the derivation without colliding with historical keys
- Namespace by operation so the same order id can drive a charge and a refund independently

### 3. Make the dedup check and the effect atomic

A dedup check that isn't atomic with the effect is a race, not a guard. Two concurrent retries both read "not seen," both proceed, and you have the duplicate you were trying to prevent.

```python
# BAD: check-then-act — TOCTOU race between the two statements
if not db.exists(key):
    charge_card(amount)          # ← concurrent request does the same thing
    db.insert(key)

# GOOD: atomic claim; the database decides the winner
try:
    with db.transaction():
        db.execute(
            "INSERT INTO idempotency_keys (key, state, request_hash) VALUES (%s,'in_progress',%s)",
            (key, request_hash),
        )
except UniqueViolation:
    return await_or_return_recorded_result(key)   # a duplicate — never re-charge

result = charge_card(amount)

with db.transaction():
    db.execute(
        "UPDATE idempotency_keys SET state='succeeded', response=%s WHERE key=%s",
        (serialize(result), key),
    )
```

The unique constraint is the entire mechanism. If your dedup store cannot enforce uniqueness atomically, it is not a dedup store.

**Guard the payload too.** If the same key arrives with a different request body, that is a client bug and must fail loudly rather than silently returning the first result:

```python
if existing.request_hash != request_hash:
    raise IdempotencyKeyReuseError(key)   # 422 — do not serve the wrong cached response
```

### 4. Handle the in-flight duplicate explicitly

The `in_progress` state is not a detail — it is the common case under retry storms. Decide the behavior deliberately:

| Strategy | Behavior | Use when |
|---|---|---|
| **Reject** | Return `409 Conflict` immediately | Client can retry later; simplest and safest |
| **Wait** | Poll for terminal state, bounded | Callers need the result synchronously |
| **Return pending** | `202 Accepted` + status URL | Long-running effects |

Never let the second caller proceed to the effect because the first one "seems stuck." A stuck first attempt whose fate is unknown is exactly the case where duplicating is most likely.

### 5. Push the key to the external boundary

Your internal dedup does not protect you from a duplicate you already sent. If the provider supports idempotency, forward the key — and use *your* key, so both sides agree on identity:

```python
stripe.PaymentIntent.create(..., idempotency_key=key)
```

If the provider has no idempotency support, you cannot prevent the duplicate — you can only detect it. That means recording your intent *before* the call, so a crash between call and response leaves evidence:

```
write intent → call provider → write outcome
              ↑ crash here leaves an "unknown" row that reconciliation must resolve
```

An `unknown` row is not a failure to be swept under the rug. It is the specific state reconciliation exists for.

### 6. Reconcile, because prevention is never complete

Every money-movement system needs a periodic job that compares your ledger to the provider's and reports drift. Idempotency reduces duplicates; reconciliation is how you *know* the rate is zero.

```
For each local record in state 'unknown' or older than the settlement window:
  fetch provider's view by idempotency key
  → provider applied it, we recorded nothing  → record it (we under-counted)
  → we recorded it, provider has no record    → investigate (we over-counted)
  → both agree                                → mark reconciled
Emit: drift_count, drift_amount, oldest_unreconciled_age
```

Alert on `oldest_unreconciled_age`, not just count. A stuck reconciliation is invisible in a count that stays flat.

### 7. Expire keys on a defensible schedule

Keys cannot live forever, and the retention window is a correctness parameter, not a storage optimization. Retain at least as long as the longest possible retry chain — including a client that retries the next morning, and any provider dispute window. A 24-hour TTL against a queue with a 7-day DLQ replay is a duplicate waiting to happen.

## Common Rationalizations

| Rationalization | Rebuttal |
|---|---|
| "Our queue guarantees exactly-once delivery" | No queue does across a consumer crash. The broker's ack and your side effect are not in one transaction. Kafka's "exactly-once" covers Kafka-to-Kafka, not your card charge. |
| "Retries are rare, the window is tiny" | Retries are *correlated*. They spike exactly when the provider is degraded — the moment duplicates are most likely and most expensive. |
| "The unique constraint on the orders table already handles it" | That protects one table. It doesn't stop the email, the webhook, or the provider call that happened before the insert failed. |
| "We'll add idempotency when we see duplicates" | You will see them in a finance reconciliation months later, denominated in refunds and trust, not in an error rate. |
| "Timestamps make the key unique" | A key that changes per attempt isn't a key. That's the bug, written deliberately. |
| "It's internal-only, both sides are our code" | Internal networks time out too, and internal retries are usually more aggressive. |

## Red Flags

- `uuid4()`, `now()`, or a random value anywhere in key derivation
- `if not exists(...)` followed by the effect on a separate line
- A dedup table with no unique index on the key
- Retry logic wrapping a call that has no idempotency key
- No `in_progress` state — only "done" and "not done"
- Agent/LLM tool definitions with side effects and no key parameter
- A reconciliation job that reports counts but has no alert on staleness
- Key TTL shorter than the DLQ replay window or the provider dispute window
- The same key namespace shared by charge and refund

## Verification

A change is not done until every item in the [idempotency review checklist](../../references/idempotency-checklist.md) is demonstrated, not asserted — replay, crash, divergence, concurrency, constraint, retention, and observability, each answered yes with evidence.

If you cannot point at a test that fails when the idempotency logic is removed, the logic is undefended and will be refactored away.
