---
name: partial-failure-in-batch-operations
description: Handles bulk calls and batched handlers so that one failing item neither drags its neighbours through the work again nor vanishes under a successful status code. Use when writing or reviewing a handler that receives a batch, or code that calls a bulk endpoint such as BatchWriteItem, SendMessageBatch, DeleteObjects or insertAll. Use when a bulk write reports success and rows are missing afterwards. Use when retrying a batch reapplies work that had already succeeded.
---

# Partial Failure in Batch Operations

## Overview

A batch is not an operation. It is N operations sharing one request, one response and — if nobody intervenes — one outcome. Almost every defect in this area comes from that last collapse: N results are folded into a single success or failure, and the items that disagreed with the majority are lost in the fold.

The fold happens in two directions and both are expensive. Fold N failures into one success and the items are deleted, dropped or acknowledged without their effect ever happening — silent loss, discovered by reconciliation. Fold one failure into N and the whole batch is retried, so every item that already succeeded is applied a second time — or, if those items hold terminal idempotency records, is skipped forever and the batch can never complete.

What makes this class worse than ordinary error handling is that the dangerous shape **returns a success status**. `BatchWriteItem` returns 200 with `UnprocessedItems`. `SendMessageBatch` returns 200 with `Failed`. `DeleteObjects` returns 200 with `Errors`. BigQuery's `insertAll` returns 200 with `insertErrors`. Every error path in the codebase is keyed on the status code, and for these calls that path never fires. The failure is in the body, and the body is what nobody reads.

## When to Use

- Writing or reviewing a handler invoked with a batch — SQS, Kinesis, Kafka poll loops, EventBridge Pipes
- Calling any bulk endpoint: `BatchWriteItem`, `SendMessageBatch`, `DeleteObjects`, `insertAll`, a provider's bulk charge or bulk email API
- Doing multi-row writes where the driver may apply some statements and not others
- Investigating a bulk write that reported success while rows are missing afterwards
- Investigating duplicated work after a batch retry, or a batch that stopped making progress
- Designing a bulk endpoint **other people** will call, where the response shape decides whether they can get this right

**NOT for:**
- The dedup mechanism itself — key derivation, atomic claims, the unknown outcome. See `idempotency-and-exactly-once`, which this skill depends on rather than restates. Per-item keys are the precondition for everything below
- Ack placement, poison messages, DLQ replay, ordering across a partition — see `queue-semantics-and-replay`; that skill owns the broker's contract with one message, this one owns what happens when a handler is handed ten
- Retry counts, backoff and circuit breaking for a single call — see `resilience-patterns`; the retry *policy* is theirs, the question of *what* to retry is here
- Chunking a backfill so each statement's lock footprint is bounded — see `data-migration-and-backfill`

## Process

### 1. Classify the batch's failure contract before writing any handling

Three classes exist. The handling differs completely, and assuming the wrong one is the root of most of this.

| Class | Response | What can be true after a failure |
|---|---|---|
| **All-or-nothing** | One status. A transaction. | Nothing applied, or everything applied. Retrying the whole batch is safe |
| **Per-item outcomes** | Success status **plus** a list of the items that failed | Some applied, some not, and the response says exactly which |
| **Opaque** | One status, no per-item detail, no transaction | Some applied, some not, and **nothing tells you which** |

Find out which you have by reading the **response schema**, not the prose. If the response type has an array of failures, errors or unprocessed entries, you are in class 2 and the status code is not your error signal.

Class 3 is the one to escalate. An opaque bulk endpoint cannot be used safely without either a read-back that establishes what landed, or per-item idempotency keys that make a full retry harmless. If you have neither, you do not have a usable API — say so rather than wrapping it in a retry.

```python
# Class 2, handled as if it were class 1. The common bug.
resp = ddb.batch_write_item(RequestItems=batch)
resp.raise_for_status()   # 200. Always.
# `resp["UnprocessedItems"]` holds the rows that were throttled away.
# Nobody reads it, and those rows are simply not in the table.
```

### 2. Key each item, never the batch

The batch is not a stable identity. SQS redelivers *individual* messages, so the batch on a retry is a different set from the one that failed; a bulk endpoint's remainder is a different set too. An idempotency key derived from the batch, the request id or the invocation is therefore a key that never repeats, which makes it useless, or that repeats over a different membership, which makes it dangerous.

```python
# Wrong: one key for a membership that will never recur.
key = f"batch:{context.aws_request_id}"

# Right: the item's own identity, stable across every redelivery of it.
for record in event["Records"]:
    key = f"sqs:{record['messageId']}"
```

Keying per batch fails in the direction that is hardest to see: the retry's key is *different*, so nothing is deduplicated and every item that already succeeded is applied again.

### 3. Release and report — both, or neither works

For a batch handler, a failing item needs two things to happen, and doing one without the other is a silent defect in opposite directions.

| What you do | What happens |
|---|---|
| Release the key, don't report | The source considers the item handled and deletes it. The effect never happened |
| Report, don't release the key | The item is redelivered, finds its key held or terminal, skips the body, and is reported again. It looks retried and is not |
| Raise out of the whole handler | The source redelivers **every** item in the batch, including the ones that succeeded. If their keys are terminal they are skipped on the way back, so the batch makes no further progress and the failure never clears |
| Release **and** report | The item comes back and runs |

```python
def handler(event, context):
    failures = []
    for record in event["Records"]:
        try:
            run_once(key_for(record), lambda: process(record))
        except Exception:
            # Reported, not raised: raising redelivers the whole batch.
            failures.append({"itemIdentifier": record["messageId"]})
    return {"batchItemFailures": failures}
```

And then check the setting. On SQS that return value is ignored unless the event source mapping has `ReportBatchItemFailures` enabled — the code above is correct and does nothing without it. Reviewing the handler without reviewing the mapping is reviewing half of it.

### 4. Retry the remainder, and prove it shrinks

A partial failure is retried by resending **what did not land**, never the original batch.

```python
remaining = items
previous = None
for attempt in range(MAX_ATTEMPTS):
    resp = ddb.batch_write_item(RequestItems=remaining)
    remaining = resp.get("UnprocessedItems") or {}
    if not remaining:
        return
    if count(remaining) == count(previous or {}):
        # Not throttling. Something in here cannot be written, and
        # sleeping longer will not change that.
        raise PermanentBatchFailure(remaining)
    previous = remaining
    sleep(backoff(attempt))
raise BatchExhausted(remaining)
```

Two guards, both earned:

- **The non-shrinking check.** `UnprocessedItems` is usually capacity, and backoff clears it. When the count stops falling, it is not capacity — it is an item that will never be accepted, and the loop will otherwise run until the function times out while reporting nothing.
- **A bounded loop that raises what is left.** A `while remaining:` with no bound is the shape that turns one bad row into a wedged worker. Whatever is still unwritten when the budget runs out must leave the function as data, not as a log line.

### 5. Decide whether order survives a partial retry

A partial retry reorders by construction: the remainder goes out after items that were sent with it. If the items are independent, write that down — it is a real assumption that someone will later break. If they are not, the batch cannot be partially retried, and the handler stops at the first failure and resumes from there instead.

### 6. Count items, not calls

A batch-level success counter reads 100% while three per cent of items fail, which is exactly how this survives a dashboard. Every metric in this path is per item: items submitted, items applied, items reported as failed, items still unprocessed when the budget ran out. The last one is the alarm; see `observability-for-correctness` for the shape.

## Common Rationalizations

**"The call returned 200, so it worked."**
The status covers the request reaching the service and being understood. For `BatchWriteItem`, `SendMessageBatch`, `DeleteObjects` and `insertAll` it says nothing about whether the items were applied. Those services report item outcomes in the body because partial success is the normal case, not an exception.

**"We retry the whole batch, so nothing gets lost."**
Nothing gets lost and things get applied twice — unless every item is keyed, in which case you have already done the work this skill asks for. If the keys are terminal on success, the whole-batch retry is worse than useless: the successes are skipped, the failure recurs, and the batch never clears.

**"Our batches are only ten items."**
Size is not the variable. One failing item out of two produces every defect here; ten only changes how much work gets repeated.

**"The SDK retries unprocessed items for us."**
Some do, some hand them back, and some do it only for throttling and not for validation errors. Which one you have is a documented fact you can check in a minute, and "the SDK handles it" has been wrong often enough that checking is cheaper than assuming. Then check the SDK's retry is bounded.

**"We'd see it in the error rate."**
You would not. The call succeeded. That is the entire difficulty of this class, and it is why the verification below is about the response body rather than about exceptions.

**"The failures go to the DLQ anyway."**
Only for items the source knows failed. An item you dropped by returning success on its behalf never reaches a dead-letter queue, because nothing ever considered it failed.

## Red Flags

- A bulk call whose result is checked only with `raise_for_status()`, `if resp.ok`, or a bare `try/except`
- `UnprocessedItems`, `Failed`, `Errors` or `insertErrors` not appearing anywhere in the codebase, for a service that returns them
- An SQS or Kinesis handler that does not return `batchItemFailures`, or returns it with `ReportBatchItemFailures` disabled on the mapping
- A retry that resends the original batch variable rather than the remainder
- `while remaining:` with no attempt bound, or a bound that logs and returns rather than raising
- An idempotency key built from a request id, invocation id or batch id
- Metrics or log lines emitted once per batch call
- A handler that raises on the first bad item, in a source that redelivers whole batches
- A bulk endpoint of your own design that returns 204, or a count, instead of per-item outcomes

## Verification

Each of these fails concretely when the corresponding logic is removed. If you cannot point at one, that logic is undefended.

1. **The middle item fails.** Submit three items with the second rejected. Assert items one and three are applied exactly once, the second is reported, and the call does not raise. Deleting the failure-list read makes this fail.
2. **The reported item actually runs on redelivery.** Redeliver the reported item alone and assert the body executes and nothing is reported. This is the test that catches reporting without releasing the key — the failure that otherwise looks like a working retry.
3. **The remainder, not the batch.** Stub the bulk call to return one unprocessed item, then empty. Assert the second call carries exactly that item. A test that only asserts "called twice" passes against a whole-batch retry and proves nothing.
4. **The non-shrinking loop terminates.** Stub the call to return the same unprocessed item forever. Assert the code raises with that item in the error, within the attempt bound, rather than looping.
5. **Nothing is swallowed at the end.** Exhaust the attempt budget and assert the leftover items leave the function as data — a raised error or a returned list — not only as a log line.
6. **Success is counted per item.** Run the mixed batch from (1) and assert the applied counter reads 2 and the failed counter reads 1. A counter that reads 1 and 0 is the dashboard that hides this class.
