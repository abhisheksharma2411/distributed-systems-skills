---
name: observability-for-correctness
description: Instruments systems to detect silent wrongness — drifted ledgers, stuck records, invariants that stopped holding — rather than slowness or crashes. Use when a correctness bug was found by a customer, an auditor or a month-end close instead of by a monitor. Use when deciding what to alert on for a reconciliation job, an outbox, a queue consumer or a state machine. Use when a dashboard was green throughout an incident that corrupted data. NOT for latency, error-rate or saturation monitoring of a healthy-or-down service, and NOT for choosing a tracing vendor or a log pipeline.
---

# Observability for Correctness

## Overview

Ordinary monitoring answers *is it up, and is it fast?* Both questions have the same shape: the system is either serving or it is not, and the signal is loud. A correctness defect has the opposite shape. Throughput is normal, latency is normal, the error rate is zero, every dashboard is green — and the numbers are wrong.

They stay wrong, because nothing is looking. The ledger drifted by eleven cents on Tuesday and it is Friday. Four thousand outbox rows have been unsent for a day because the publisher thread died while the process stayed healthy. A state machine has records sitting in `PENDING` from last month, and `PENDING` is a legal state, so nothing fires.

These are found by a customer, an auditor, or a month-end close. By then the question is not "what is broken" but "how far back does this go, and what do we owe" — which is a reconstruction project, not an incident.

The shift this skill asks for: **stop monitoring the machinery and start monitoring the invariant.** A queue consumer that is running is not evidence that messages are being processed correctly. The evidence is that the thing the consumer exists to keep true is still true.

## When to Use

- A correctness bug was found by a human process — a customer, an auditor, a close, a reconciliation — rather than by a monitor
- Deciding what to alert on for a reconciliation job, an outbox, a consumer, a backfill, or a state machine
- Reviewing an incident where every dashboard stayed green while data was being corrupted
- Adding a background job whose failure is silent, or whose *success while doing nothing* is silent
- Choosing what a job should report when it finds nothing to do

Not for: latency, error-rate and saturation monitoring of a request path; capacity planning; choosing a tracing, logging or metrics vendor; debugging a single request after a user reports it.

## Process

### 1. Write the invariant as a query before writing the alert

An invariant is a sentence that must be true about the data, independent of any code path. It is checkable by a query that does not go through the application.

> Every `SUCCEEDED` payment has exactly one ledger entry pair summing to zero.
> No record sits in `PENDING` for longer than its SLA.
> The outbox contains no row older than 60s with `published_at IS NULL`.
> The sum of all account balances equals the sum of all entries.

Write the query first, run it against production, and look at the number it returns today. That number is almost never zero, and finding out *now* is the point: a drift alarm deployed at a threshold of zero against a system already drifting pages immediately and gets silenced within a week.

### 2. Alarm on the age of the oldest unresolved thing, not the count

Counts are the instinct and they are the wrong instrument. A backlog of 400 is fine if it drains in seconds and catastrophic if those 400 have been there since Tuesday. Worse, a count that is flat looks healthy on a graph whether it is 400 different rows arriving and draining or the same 400 rows stuck forever.

**Age distinguishes those two. Count does not.**

```sql
SELECT EXTRACT(EPOCH FROM now() - MIN(created_at)) AS oldest_unresolved_seconds
FROM outbox WHERE published_at IS NULL;
```

Alarm when the oldest unresolved item is older than the SLA for resolving it. That one signal catches a dead publisher, a poison row at the head, a consumer in a crash loop, and a steady arrival rate that has quietly overtaken the drain rate — none of which a count reliably shows.

### 3. Make "nothing to do" and "did not run" different signals

A nightly reconciliation that finds no discrepancies and a nightly reconciliation that never started both produce no alert. They are the same silence, and the second one is the dangerous one. A job that has not run for three weeks is indistinguishable from three weeks of clean closes.

Emit a heartbeat on every successful completion — the timestamp, the number of items examined, the number of discrepancies found — and alarm on the **absence** of a recent heartbeat. The job is then monitored by something outside it, which is the only arrangement that survives the job dying.

Zero items examined is itself worth alarming on. A reconciliation that examined nothing because its query silently stopped matching is reporting a clean bill of health for work it did not do.

### 4. Count the states, including the ones you believe are impossible

Export one gauge per state of every state machine, including the terminal ones and the ones that "cannot happen". A state with no legal exit — a record that is `IN_PROGRESS` with its worker long gone, an `UNKNOWN` outcome nobody resolved — is invisible to error-rate monitoring because nothing errored.

The alarm is on the shape, not the volume:

- a state whose population only grows and never drains
- a state that was empty for months and is suddenly not
- a record older than the maximum time that state is allowed to last

An `impossible_state_total` counter that has been flat at zero since launch costs nothing and is the only thing that will tell you the day it moves.

### 5. Reconcile against the system that knows, and record the answer

Internal consistency is the weaker check. Your ledger agreeing with itself says nothing about whether it agrees with the payment provider, who is the one that actually moved the money.

Compare against the external source on a schedule, and emit three numbers that must be separate: **matched**, **missing locally**, **missing remotely**. Collapsing them into one "discrepancy count" throws away the direction, and the direction is the diagnosis — charges the provider has that you do not are lost revenue, and ones you have that the provider does not are a far worse problem.

Record every reconciliation run, including clean ones. The record is what lets you answer "when did this start" without a reconstruction project, and that question is asked about every drift that is ever found.

### 6. Put the invariant where it fails loudly in tests too

The same invariant that alarms in production should run at the end of integration tests. A test suite that asserts the API returned 200 and never checks that the ledger still balances will pass through exactly the change that breaks it.

This is the cheapest half of the whole skill: the query is already written, and running it against the test database costs nothing.

## Common Rationalizations

| Excuse | Reality |
|---|---|
| "We have 100% uptime and a zero error rate" | Both are true of a system computing wrong answers perfectly reliably. Neither measures correctness. |
| "The reconciliation job alerts if it finds a problem" | And is silent when it does not run. Those are the same silence, and one of them is three weeks of undetected drift. |
| "We monitor the queue depth" | Depth cannot tell 400 rows draining in seconds from the same 400 rows stuck since Tuesday. Age can. |
| "`PENDING` is a legal state, there's nothing to alert on" | Legal for ten seconds, not for a month. The alert is on the age, not the state. |
| "That state can't happen" | Then the counter stays at zero and costs you nothing. The day it moves is the day you need it. |
| "We'll know because customers complain" | You will know about the ones who noticed and bothered. That is a sampling method, and a biased one. |
| "We log everything, we can query it later" | Logs answer questions you thought to ask about a window you still have. An invariant that is never evaluated is not monitored. |

## Red Flags

- A correctness incident whose timeline begins with a customer email rather than an alert
- Dashboards full of rate, latency and error panels, with nothing that would move if the data were wrong
- A background job with no heartbeat, so "clean" and "did not run" look identical
- Backlogs alarmed on count alone, with no age signal
- A state machine with no per-state gauge, or one that omits the states believed impossible
- A single "discrepancy count" that does not distinguish missing-locally from missing-remotely
- Reconciliation runs that are only recorded when they fail, so the first clean run has nothing to compare against
- An invariant that exists in a runbook as a sentence but nowhere as a query

## Verification

- [ ] Every correctness invariant is written as a query that runs outside the application, and has been run against production at least once
- [ ] Backlogs and unresolved work alarm on the age of the oldest item, not only on a count
- [ ] Every scheduled job emits a heartbeat on success, and absence of a heartbeat alarms independently of the job
- [ ] A job that examined zero items is distinguishable from a job that examined many and found nothing wrong
- [ ] Every state machine exports a gauge per state, including terminal and believed-impossible states
- [ ] External reconciliation reports matched, missing-locally and missing-remotely separately
- [ ] Every reconciliation run is recorded, clean ones included, so "when did this start" is answerable from data
- [ ] At least one invariant query runs in the test suite and fails the build when it breaks
