---
name: data-migration-and-backfill
description: Changes a schema or backfills a column on a live system without downtime, lost writes, or a half-migrated state nobody can reason about. Use when adding, renaming, splitting or dropping a column on a table that is being written to, when planning an expand-migrate-contract rollout, or when writing a backfill that must survive being interrupted. Use when deciding whether old and new shapes agree well enough to cut reads over, or when a deploy left some rows migrated and others not.
---

# Data Migration and Backfill

## Overview

A migration on a live system is not one change. It is a sequence of states the system passes through, and **every one of those states runs in production under full traffic** — including the ones that exist for ten minutes during a deploy.

Most migration failures are not failures of the final state. The final state is usually fine; it is the one that was designed. The damage happens in the intermediate states nobody wrote down: the window where new code writes a column old code does not read, the window where a backfill is half done and a query returns a mix of shapes, the window where a rollback would have been possible and then was not.

The second thing that goes wrong is the backfill itself. A backfill over a real table **will** be interrupted — a deploy, an OOM, a lock timeout, someone pressing Ctrl-C at 2am because it was slowing the primary. A backfill that cannot be re-run from where it stopped turns one interruption into a manual reconciliation.

## When to Use

- Adding, renaming, splitting, merging, or dropping a column on a table that is being written to
- Backfilling a new column or table from existing data
- Changing a column's type, nullability, or encoding on a live table
- Moving data between stores, or changing which store is authoritative
- Reviewing a migration PR, especially one that changes schema and application code together
- Investigating rows that are missing the new shape after a migration "completed"

Not for: migrations on a system with a real maintenance window and no concurrent writes, local schema design before anything has shipped, or choosing a migration *tool*.

## Process

### 1. Write down every intermediate state before writing any of them

List the states the system passes through, in order, and for each one name what is writing, what is reading, and which shape each believes in. A migration plan that is a list of SQL statements is not a plan; it is the last line of one.

The states that matter are the ones spanning a deploy, because during a rolling deploy **old and new code run at the same time against the same table**. If the plan does not have a state where that is true, the plan is wrong — that state exists whether or not it was written down.

### 2. Expand, migrate, contract — and never collapse two of them into one deploy

- **Expand** — add the new shape. Nullable, defaulted, no constraint that existing rows violate. Nothing reads it.
- **Migrate** — write both shapes, backfill the old rows, verify they agree.
- **Contract** — cut reads to the new shape, let it settle, *then* remove the old.

Each is a separate deploy. Combining expand and contract is what produces an outage: the moment the old column is gone, every process still running the previous release is writing to a column that no longer exists.

Adding a `NOT NULL` column with a default in the expand step is the common version of this mistake — on most engines that is a table rewrite holding a lock, which is a maintenance window wearing a migration's clothes.

### 3. Make the dual-write honest, or do not call it one

Writing to the old shape and the new shape in two separate operations is a **dual write**, and it drifts: the first succeeds, the process dies, the second never happens. Now the two disagree and nothing knows.

There are exactly two honest options:

- **One transaction** — both writes in the same transaction against the same store. Simple, and only available when they *are* the same store.
- **An outbox** — write the row and an intent record in one transaction; a relay applies the second write. The intent survives the crash, so the second write is retried rather than lost.

If neither is available, say so in the plan and treat the new shape as derived-and-reconciled rather than authoritative. What is not acceptable is two writes with a crash window between them described as "we write both".

### 4. Write the backfill to be resumed, not restarted

A backfill is interrupted. Design for it:

- **Keyed, not blind.** `UPDATE ... WHERE id = ?` with a value derived from the row, not `UPDATE ... SET x = x + 1` or anything whose result depends on how many times it ran.
- **Checkpointed.** Record the last key processed, durably, outside the process. On restart, continue from it. A checkpoint in memory is not one.
- **Batched with a bound.** Fixed-size batches over a sorted key, so each statement's lock footprint is known and a batch can be retried alone.
- **Re-runnable from zero.** The strongest property: running the whole backfill twice produces the same result as running it once. If that holds, a lost checkpoint costs time rather than correctness.

Filtering on `WHERE new_column IS NULL` to find remaining work is attractive and is **not** a checkpoint — it is correct only while nothing else writes `NULL` into that column, and the dual-write you added in step 3 does exactly that for new rows.

### 5. Verify that old and new agree, over the whole table, before contracting

Run a query that compares the two shapes for **every** row and returns the disagreements. Run it to completion. A sample is not verification; neither is staging, which has neither the volume nor the weird historical rows that are the reason this is hard.

Expect a non-zero answer the first time, and investigate rather than widen the comparison until it passes. The rows that disagree are usually the ones the migration logic never considered — nulls, legacy encodings, a tenant onboarded before a constraint existed.

Verification has to happen *after* dual-writing is live and the backfill has finished, because a row written between the backfill and the check is only correct if the dual write is working. The verification proves both.

### 6. Name the point of no return in the plan, in those words

Every migration has a step after which rollback stops being a deploy and becomes a restore from backup. Usually it is dropping the old column; sometimes it is earlier, when a destructive transform loses information the old shape held.

Write that step down and mark it. Before it, the rollback is "deploy the previous release". After it, the rollback is "restore a backup and lose everything written since", which is a different conversation with different people in it.

A plan that does not identify its point of no return will cross it during an incident, at the worst moment, without anyone noticing it happened.

## Common Rationalizations

| Excuse | Reality |
|---|---|
| "It's a small table" | Table size decides how long the lock is held, not whether concurrent writes exist. The race is the same at a thousand rows. |
| "The backfill only takes a few minutes" | It takes a few minutes when nothing goes wrong. Resumability is about the run that is interrupted, which is the one you did not plan for. |
| "We can just re-run the backfill if it fails" | Only if it is idempotent. A blind `UPDATE` re-run is how a counter column ends up double-counted with no way to tell which rows. |
| "We verified in staging" | Staging does not have the rows that break this. The 2019 tenant with the null currency code is in production only. |
| "Rollback is just reverting the deploy" | True until the contract step. After it, rollback is a restore. If the plan does not say which step that is, it does not have a rollback plan. |
| "Old and new code won't overlap, it's a fast deploy" | A rolling deploy overlaps by definition, and a slow pod, a stuck drain, or a rollback extends it arbitrarily. |
| "`WHERE new_col IS NULL` tells us what's left" | It does until dual-writing starts inserting new rows, and then it is a work queue that refills itself. |

## Red Flags

- A migration PR that adds a column and reads it in the same deploy
- `NOT NULL` with a default added to a large existing table in one statement
- A backfill script with no checkpoint, or a checkpoint held only in a local variable
- A backfill whose remaining work is found with `WHERE new_column IS NULL` while a dual write is live
- Two writes in sequence, in different transactions or different stores, described in the PR as a dual write
- A verification step that samples, or that was run only against staging
- A plan with no step labelled as the point of no return
- "Expand and contract" in the PR description with both in the same release

## Verification

- [ ] Every intermediate state is written down, including the one where old and new code run together
- [ ] Expand, migrate, and contract are separate deploys, and nothing reads the new shape before the backfill has verified
- [ ] The dual write is one transaction or an outbox — not two sequential writes with a crash window between them
- [ ] The backfill is keyed and idempotent: running it twice gives the same result as running it once
- [ ] The checkpoint is durable and outside the process, and resuming from it has actually been exercised, not just written
- [ ] Remaining work is found from the checkpoint, not from `WHERE new_column IS NULL`
- [ ] Verification compares old and new for every row, ran to completion against production, and returned zero disagreements
- [ ] The point of no return is identified by name in the plan, and the rollback for each side of it is stated
