---
name: money-movement-correctness
description: Reviews and designs ledgers so balances are provable, reversals are ordinary, and what you intended can be reconciled against what the provider did. Use when a schema has a balance column, or when writing code that credits, debits, settles, refunds or claws back. Use when balances disagree with a provider statement, or when finance asks why a number moved and nobody can answer.
---

# Money Movement Correctness

## Overview

There is one structural decision in a money system, and almost every later problem is downstream of getting it wrong:

```sql
UPDATE accounts SET balance = balance + 50 WHERE id = ?   -- the whole problem
```

A balance in a mutable column is a number with no history. When it is wrong — and eventually it is wrong — there is no way to find out when it became wrong, what moved it, or what it should have been. You cannot reconstruct it, so you cannot prove it, so you end up trusting it. Finance then asks why a merchant's balance dropped on the 14th and the honest answer is that nobody can say.

The alternative is not more careful updates. It is to stop storing the balance as a fact at all: **the log of entries is the truth, and every balance is a derived view of it.** An entry is never updated and never deleted. Everything else in this skill follows from that, including the parts that look like they are about disputes or settlement.

The second idea worth stating up front, because it settles most arguments about reconciliation: **the provider is authoritative for what happened; your ledger is authoritative for what you intended.** Neither is "the truth" alone, and a reconciliation that assumes one is simply overwrites real information with other real information.

## When to Use

- Any schema with a `balance`, `credits`, `wallet` or `available_funds` column
- Writing or reviewing code that credits, debits, settles, refunds, claws back or pays out
- Designing how a dispute, chargeback or reversal flows through the system
- Balances disagreeing with a provider statement, or two internal views disagreeing
- Finance asking why a number moved and nobody being able to answer
- Adding a "just this once" adjustment or correction path

**NOT for:**
- Making an individual charge safe to retry — see `idempotency-and-exactly-once`, which every entry-writing path here depends on
- Keeping the ledger service consistent with other services that share no transaction — see `distributed-data-consistency` for outbox, sagas and invariant monitoring; this skill covers what the invariants *are* for money
- Enumerating what breaks when the provider is slow or down — see `failure-mode-analysis`
- Regulatory scope: which licences you need, KYC, AML. That is a legal question and this is an engineering skill

## Process

### 1. Make the entry log the truth and the balance a view

```sql
-- BAD: a number with no history. When it is wrong, nothing can say why.
UPDATE accounts SET balance = balance + %s WHERE id = %s;

-- GOOD: append-only. The balance is whatever the entries say it is.
INSERT INTO ledger_entries (account_id, amount_minor, currency, direction,
                            transfer_id, reason, occurred_at)
VALUES (...);

SELECT COALESCE(SUM(CASE WHEN direction='credit' THEN amount_minor
                         ELSE -amount_minor END), 0)
  FROM ledger_entries WHERE account_id = %s AND currency = %s;
```

Entries are **immutable**. No `UPDATE`, no `DELETE`, no correcting a typo in place — a wrong entry is fixed by writing a compensating entry, so the record shows both what was believed and what corrected it.

Performance is the objection, and it is answered by a periodic **snapshot**: a materialised balance at a point in time, plus the entries since. That is a cache with a rebuild path, which is a different thing from a mutable balance: you can always recompute it and check.

Two details that cause real incidents:

- **Store minor units as integers.** Floats do not represent `0.10`, and a rounding difference of one unit across a million rows is a reconciliation that never closes.
- **Currency travels with every amount.** A column that holds "the amount" and assumes everything is USD is a bug waiting for the first EUR merchant.

### 2. Write the invariants as queries, and run them

These are not documentation. They are assertions with a threshold and an alert.

```
every transfer's entries sum to zero                       -- double-entry itself
no account balance is negative without a credit facility
every external movement has a local entry, and vice versa
no entry references a transfer that does not exist
sum of all account balances == sum of all entries
```

The first one is what "double-entry" actually buys you: money moves *between* places, so an entry that credits without a matching debit means value appeared from nowhere, and a query can say so in one line. A system where that query has never been run does not have double-entry, it has two columns.

Run them in CI against a seeded database, and on a schedule in production. Alert on the **age** of the oldest violation, not the count.

### 3. Reconcile against the provider, and know who wins

The provider knows what moved. You know what you meant. Reconciliation is where those meet, and it has exactly three outcomes:

```
provider has it, we do not     → we under-recorded. Write the entry; investigate why.
we have it, provider does not  → we over-recorded, or it never left. Do NOT delete
                                  the entry — write a compensating one, with a reason.
both, amounts differ           → a human. Never auto-correct a mismatch in amount.
```

Run it per **settlement window**, not per transaction, and reconcile the window total as well as the line items — a set of individually-correct rows can still miss a fee the provider deducted.

The rule that keeps this honest: reconciliation may *add* entries and may *flag*, but it may never edit or remove one. The moment it can, your audit trail is a record of what reconciliation last decided rather than what happened.

### 4. Treat reversals and disputes as ordinary flows

Refunds, chargebacks, clawbacks and failed payouts are not exception handling. They are normal states of a money system, and building them later means retrofitting them into a schema that assumed money only flows one way.

Each is a **new entry**, never a mutation of the original:

```
charge        →  credit merchant, debit customer-funds
refund        →  the reverse pair, referencing the original transfer
chargeback    →  the reverse pair, plus a fee entry, plus a state change on the dispute
clawback      →  a debit against the merchant, which may drive the balance negative
```

The negative balance is the interesting one. A clawback on a merchant who has already been paid out is exactly the case a mutable balance column handles by silently going negative or by refusing and losing the record. Decide deliberately: allow it and treat it as a receivable, or refuse it and queue it — but decide, and make the invariant match the decision rather than the other way round.

Every reversal entry carries the id of what it reverses. Without that link the ledger sums correctly and tells you nothing about why.

### 5. Make the audit trail answer "why", not just "what"

Every entry needs who, what, when and **why** — an actor, a reason code, and the id of whatever authorised it. The first three are usually there; the fourth is the one that is missing when someone asks about the 14th.

Retention is a correctness parameter here in the same way idempotency-key retention is: it must outlive the dispute window, the regulatory window, and any period over which someone might ask. Deleting a ledger row to satisfy an erasure request is an invariant violation — resolve that tension with tokenisation and by separating personal data from the entry, not by deleting the entry.

### 6. Make every money-moving call idempotent, and mean it

Every path that writes an entry needs a stable key derived from the intent, and the provider's own idempotency key should be the same value so both sides agree on identity. The mechanism is `idempotency-and-exactly-once`; what this skill adds is *which* operations count, and the answer is all of them — including refunds, including clawbacks, including the correcting entry that reconciliation writes.

A retried reconciliation that writes its correcting entry twice has created the drift it was run to remove.

## Common Rationalizations

| Rationalization | Rebuttal |
|---|---|
| "A balance column is simpler, and it's correct if the updates are correct" | It is correct until it is not, and then there is no way to find out when it stopped being correct or what it should have been. The cost is not the bug, it is being unable to investigate it. |
| "We keep an audit log alongside the balance" | Then you have two sources of truth that can disagree, and no rule for which wins. Derive the balance from the log and there is only one. |
| "Double-entry is accounting ceremony, we're an engineering team" | It is a checksum. Entries summing to zero per transfer is one query that catches value appearing from nowhere, and it is the only cheap way to catch it. |
| "Floats are fine, we round at the end" | Rounding differences of one minor unit across a million rows are a reconciliation that never closes, and the discrepancy grows quietly. |
| "We'll add refunds and disputes later" | Later means retrofitting reversals into a schema that assumed money moves one way, usually by mutating the original record, which destroys the history you need to explain the dispute. |
| "Reconciliation can just fix the mismatch" | Then the ledger records what reconciliation last decided, not what happened. It may add and flag; it may never edit. |
| "The provider is the source of truth, we mirror it" | The provider knows what *moved*. It does not know what you *intended*, so it cannot tell you about the payout you meant to send and never did. |
| "We can recompute the balance from the payments table" | The payments table is one flow. Fees, adjustments, clawbacks and manual corrections are not in it, and those are the entries that explain the discrepancy. |

## Red Flags

- `UPDATE ... SET balance = balance ± ...` anywhere
- `UPDATE` or `DELETE` against a ledger or entries table
- Monetary amounts in `float`, `double` or `REAL`
- An amount column with no currency column beside it
- No query anywhere asserting that a transfer's entries sum to zero
- A refund implemented by mutating or deleting the original charge row
- A reversal entry with no reference to what it reverses
- No reason code or actor on entries — only amount and timestamp
- A reconciliation job with an `UPDATE` in it
- Reconciliation per transaction with no check of the settlement-window total
- Balance snapshots with no rebuild-from-entries path
- A clawback path that is undefined when the merchant has already been paid out
- Ledger rows deleted for data-retention or erasure requests

## Verification

Each is a test, and each fails concretely when the mechanism is removed.

1. **Entries sum to zero, per transfer, over the whole table.** One query, run in CI against a seeded database. Seed a violation and confirm it fails — an invariant that has never fired is one nobody knows the shape of.
2. **The derived balance equals the snapshot.** Rebuild from entries and compare against the materialised value for every account. This is the test that makes a snapshot a cache rather than a second truth.
3. **A refund leaves the original entries untouched.** Assert the charge's rows are byte-identical afterwards and that the reversal references them. Fails the moment someone implements a refund as an update.
4. **A double-submitted refund refunds once.** Same key, two calls, one pair of entries. Then the same for a clawback and for reconciliation's correcting entry — the paths people forget to key.
5. **A clawback against an already-paid-out merchant does what you decided.** Whichever you chose, assert it. An undefined answer here is how a balance silently goes negative in production.
6. **Reconciliation never mutates.** Run it against seeded drift in all three directions and assert the entry count only grows and no existing row changed.
7. **Every entry has an actor and a reason.** A schema-level constraint plus a test, because this is the field that gets added as nullable and stays empty.

If you cannot point at a test that fails when a balance is set directly rather than derived, the ledger is a convention rather than a guarantee, and conventions do not survive an incident at 3am.
