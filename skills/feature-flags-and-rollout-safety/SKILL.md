---
name: feature-flags-and-rollout-safety
description: Adds and reviews feature flags, kill switches and percentage rollouts so that a flag read twice in one workflow cannot answer differently and strand work half-done. Use when guarding a code path behind a flag or an experiment, when ramping a percentage, or when adding a kill switch. Use when a flow spans more than one process, request or scheduled run and each part reads the flag for itself. Use when investigating work that started on one code path and finished on another, or an experiment whose arms do not add up.
---

# Feature Flags and Rollout Safety

## Overview

A feature flag looks like a branch and behaves like a distributed variable. The branch is evaluated wherever the code happens to be, whenever it happens to run — and in any workflow that spans two steps, those are two different evaluations of something that can change in between.

The resulting defect is specific and nasty: **work that starts on one code path and finishes on the other.** A scheduler picks the new algorithm and writes a plan for it; ten minutes later the executor reads the flag, which has since been ramped down, and executes that plan with the old one. Nothing crashed. No request failed. The two halves simply disagreed, and the only trace is a record that makes sense under neither path.

Rollouts make this routine rather than rare. The ramp is the moment a flag's value is *most* likely to change between two reads, which is exactly when the most traffic is flowing through both branches.

And the measurement has the same shape. An experiment that re-decides which arm a subject belongs to on every evaluation does not have two arms; it has a smear. Its results are not merely noisy — they are not measuring the thing they claim to measure, and they will still produce a confident number.

## When to Use

- Putting a code path behind a flag, an experiment, a percentage rollout or a kill switch
- Any flow where the decision and the work happen at different times: a scheduler and a worker, a request and its retry, a saga across steps, a job that resumes
- Ramping a percentage, or planning the order of a rollout
- Reviewing code that reads the same flag in more than one place
- Investigating a record that is consistent with neither code path, or an experiment whose arm totals do not reconcile

Not for: choosing a flag vendor, build-time compilation flags, static configuration that only changes on deploy, or ordinary application config with no behavioural branch.

## Process

### 1. Decide the flag once per unit of work, then carry the decision

The unit of work is whatever must not be split: an order, an invoice, a saga instance, a job run. Resolve the flag once at its start, persist the answer with the work, and have every later step read that stored answer rather than the flag.

```python
# At the start of the unit of work, once.
if invoice.algorithm is None:
    invoice.algorithm = flags.resolve("retry_algorithm", invoice.id)
    invoice.save()

# Everywhere afterwards, including other processes and later runs.
algorithm = invoice.algorithm
```

The check for "is it already decided?" is the whole mechanism. Without it this is just another evaluation.

Two consequences worth stating where the field is defined:

- **Store it as a value, not an enum reference that must stay in sync.** A stored arm that is no longer a known value should degrade to "resolve again, and log it", not to a deserialization failure that takes down the row.
- **A unit of work in flight keeps its old behaviour after the flag is removed.** That is the correct outcome, and it means flag cleanup has to drain or migrate in-flight work rather than just deleting the branch.

### 2. Read it once per request too

Even inside one process, two reads of the same flag are two values. A provider that refreshes its cache on a background timer can return `true` at the top of a request and `false` at the bottom.

Read once at the entry point, pass the value down. A function that takes `use_new_pricing: bool` is testable and honest; one that calls `flags.is_enabled()` in its own body is neither.

### 3. Keep the kill switch above the experiment

An operational kill switch and an experiment arm are different kinds of thing and must not be flattened into one boolean:

- **The kill switch is an operator saying stop.** It wins over everything.
- **The arm is an assignment**, replayed from storage, that decides *which* behaviour runs when running is allowed at all.

```python
# The arm chooses the behaviour; the switch decides whether it runs at all.
use_new_path = arm_is_treatment and adaptive_retry_enabled
```

Getting this backwards produces the worst possible failure: an operator turns something off, and the subjects assigned to the treatment arm keep using it. **A kill switch an experiment can override is not a kill switch.**

Write down the cost of the correct ordering too — turning the switch off contaminates the treatment arm for as long as it is off. That is the right trade against ignoring an operator, but it should be a stated trade, not a surprise in the analysis.

### 4. Make the default the old behaviour, including when lookup fails

A flag lookup is a network call in most implementations, so it has three outcomes, not two. Decide explicitly what an error or a timeout means, and make it the pre-existing behaviour.

```python
try:
    enabled = flags.is_enabled("new_settlement", timeout=0.05)
except FlagServiceError:
    enabled = False      # the behaviour that was shipping yesterday
    metrics.increment("flags.lookup_failed", tags={"flag": "new_settlement"})
```

Count the failures. A flag service that is down and silently defaulting looks exactly like a flag that is off, and a rollout that quietly stopped ramping is very hard to notice.

### 5. Make the ramp reversible before starting it

- **Can this be turned off?** Not "is there a flag", but: if it is turned off now, what happens to work that is already in flight on the new path? Half-written state that the old path cannot read is not reversible, whatever the flag says.
- **Ramp by a stable identifier**, hashed — customer, account, tenant. Ramping by request or by host re-rolls the dice for every call, so one customer sees both behaviours and nobody can reproduce anything.
- **Ramp the measurement before the behaviour.** Emit which path *would* have been taken, at full traffic, before any of it changes anything. Disagreements show up with nothing at stake.
- **Name an owner and a removal date.** A flag with neither becomes permanent, and a permanent flag is a branch in production nobody tests both sides of.

### 6. Log the decision, not just the outcome

Every unit of work should carry which arm it was assigned, where that came from (resolved now, or replayed from storage), and the kill switch's state at the time. Without it, a disagreement between two steps is indistinguishable from an ordinary bug, and the analysis cannot tell a subject that switched arms from one that was always in the second.

A counter for "arrived at step two with no stored assignment" is worth more than it looks: it is zero when the mechanism works, and non-zero the moment someone adds a path that skips step one.

## Common Rationalizations

| Claim | Why it fails |
|---|---|
| "It's just an if statement." | An `if` whose condition is mutated by another system between two evaluations in the same workflow. |
| "The flag is read-only in this code path." | It is read in *this* path. The defect is the other path reading it a second time, later. |
| "The ramp is only 5%, the blast radius is small." | The ramp is when the value is most likely to change between two reads. 5% of traffic is 100% of the inconsistency window. |
| "We'd notice if it flipped mid-flow." | The symptom is a record consistent with neither path, found at reconciliation days later. Nothing errors at the time. |
| "The provider caches the value, so it's stable." | Cached with a refresh timer, which is precisely what makes two reads in one request return different values. |
| "We can clean the flag up later." | Later never has a date. The branch stays, one side of it stops being exercised, and it breaks when someone finally flips it. |
| "The experiment needs to override the kill switch or the arm is contaminated." | Contaminating an arm is a measurement problem. Ignoring an operator who said stop is an incident. |
| "Defaulting to on means we at least fail forward." | It means a flag service outage ships an untested path to everyone at once, with no deploy and no review. |

## Red Flags

- The same flag name read in two files that run at different times
- `flags.is_enabled(...)` called inside a function rather than passed into it
- A flag guarding the decision *and* re-checked where the work is performed
- An experiment arm resolved at every step rather than stored on the subject
- A kill switch ANDed in nowhere, or ORed in anywhere
- A flag lookup with no timeout, or with no explicit value on failure
- A rollout bucketed by request id, session or hostname rather than a stable subject key
- A stored arm deserialized strictly, so an unknown value raises rather than degrading
- No metric for "flag lookup failed" or "no stored assignment at step two"
- A flag older than its removal date, or with no owner

## Verification

Before a flag ships:

1. **The unit of work is named**, and the flag is resolved once per unit and stored with it.
2. **Every later step reads the stored decision**, not the flag. Including other processes, retries and resumed runs.
3. **A test flips the flag between the two steps** and asserts the work completes on the path it started on. If the flag cannot be flipped mid-flow in a test, the mechanism is not demonstrated.
4. **The kill switch dominates.** A test asserts that with the switch off, a subject assigned to the treatment arm does not take the new path.
5. **Failure defaults to the old behaviour** and increments a counter.
6. **The ramp is keyed to a stable identifier**, so one customer sees one behaviour.
7. **Turning it off is survivable** for work already in flight, and that has been described concretely rather than asserted.
8. **The flag has an owner and a removal date**, and the decision is logged per unit of work.

Related: `distributed-data-consistency` for the saga whose steps this splits, `idempotency-and-exactly-once` for the retry that re-enters a flow part-way through, and `data-migration-and-backfill` for rollouts where the reversibility question is about data rather than a branch.
