# Changelog

Notable changes to this skill pack.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions track the catalogue: a minor bump adds or materially reworks a skill.

## [Unreleased]

### Added

- **Skill: `money-movement-correctness`** ([#4]). The issue calls this the
  highest-value skill on the roadmap, and it turns on a single structural
  decision: `UPDATE accounts SET balance = balance + 50` is a number with no
  history, so when it is wrong nothing can say when it became wrong or what it
  should have been. The alternative is not more careful updates but refusing to
  store the balance as a fact at all — the entry log is the truth and every
  balance is a view of it. The performance objection is answered by a snapshot
  with a rebuild path, which is a cache rather than a second truth.

  Two framings the skill leans on. Double-entry is presented as a **checksum**,
  not accounting ceremony: entries summing to zero per transfer is one query
  that catches value appearing from nowhere, and a system that has never run it
  does not have double-entry, it has two columns. And reconciliation gets a
  rule rather than a procedure — the provider is authoritative for what
  *happened*, your ledger for what you *intended*, and reconciliation may add
  and flag but may never edit.

  The fixture is a merchant wallet plus its schema and four finance notes that
  look unrelated: a monthly gap being booked as rounding, a merchant whose
  balance dropped with no traceable cause, a negative balance after a chargeback
  landed the day after a payout, and an unanswered seven-year explainability
  requirement. Two of them are the same root cause and the eval requires saying
  so. The schema carries `DOUBLE PRECISION` for money and no currency column;
  the code's refund mutates the original charge, its chargeback deletes from the
  settlement log, and its reconciliation issues an `UPDATE`.

- **Skill: `distributed-data-consistency`** ([#3]). The defect behind most
  cross-service drift is two lines that both look fine — a commit, then a
  publish — and it is invisible in testing because both calls succeed on a
  healthy machine. The framing the skill insists on is that "keep them in sync"
  is not achievable without a transaction spanning both systems, and you do not
  have one: the goal is to make the disagreement **bounded, detectable and
  self-correcting**. The outbox bounds it, invariant monitoring detects it,
  compensation corrects it.

  Reordering is addressed head-on, because it is the first thing people reach
  for: publishing before committing turns "committed but never published" into
  "published but never committed", which is worse — consumers act on an order
  that does not exist.

  The fixture is an order pipeline whose dashboards are all green and which has
  four unconnected tickets: a monthly Stripe-versus-orders gap of 4 then 7 then
  6, eleven charged-but-no-shipment support tickets, analytics events running
  ~1% below the database, and one duplicate confirmation email. They share two
  root causes, and the eval requires connecting them rather than listing
  defects — including rejecting the fixture's own `rollback()` function, which
  resets a local column and releases neither the reservation nor the shipment.

- **Skill: `queue-semantics-and-replay`** ([#12]). A queue looks like it removes
  the hard parts of distributed systems and it relocates them: the broker will
  deliver your message, but it cannot tell you whether your *consumer* finished
  with it, and every real defect lives in that gap. Four decisions settle
  whether a consumer is correct — which guarantee you actually have, where the
  ack goes, what happens to a message that can never succeed, and whether a
  replay months later is safe — and three of them are usually made by accident,
  or by a client library's default.

  The framing the skill insists on: a dead-letter queue is not an error log, it
  is queued work, and draining one is a bulk re-delivery of effects that already
  partly happened, performed under time pressure during an incident. The
  retention rule falls out of that and is the same one
  `idempotency-and-exactly-once` states from the other side.

  The fixture is an order pipeline with three open incidents and no diagnoses —
  customers charged for orders never received, nine double charges the day after
  a DLQ drain, and a partition that stalled for forty minutes. Each has a
  distinct cause in the code, the numbers needed to prove the middle one are in
  the platform notes (48-hour key sweep against 30-day DLQ retention, drained on
  day eleven), and the notes also contain the `exactly_once_v2` misreading the
  eval requires correcting.

- **Skill: `resilience-patterns`** ([#2]). Almost every cascading outage has
  one shape: a dependency gets *slow*, not down, callers wait, and the waiting
  spreads until services with no relationship to the original fault stop
  answering. Slow is worse than down — a dependency that fails fast sheds load,
  one that hangs absorbs your capacity and returns nothing — and every pattern
  in the skill exists to convert slow into fast-failed before it spreads.

  The load-bearing cross-reference the issue asked for is explicit: this skill
  decides *whether and how* to retry, `idempotency-and-exactly-once` decides
  whether that retry is *safe*, and the handoff is stated at the retry step, in
  the rationalization table, and as the last verification item. A retry policy
  on a non-idempotent effect is a duplication policy.

  The fixture is a real postmortem with its question left open: pricing got
  slow, the whole checkout service stopped answering including `/health`, and
  nobody ever explained why an endpoint with no dependencies failed. The answer
  is the shared connection pool, and the eval requires it — along with noticing
  that the retry added *as the postmortem's action item* now retries timeouts on
  a card charge that sends no idempotency key, against a provider whose own docs
  say such a request may or may not have been applied.

- **Skill: `rate-limiting-and-quota-correctness`** ([#15]). A rate limiter is a
  distributed counter with a deadline, and almost everything that goes wrong
  with one is a counting problem rather than a policy problem. Two failures
  dominate and both are quiet: a per-instance counter enforces the limit times
  the replica count, and a limiter sitting on the hot path of every request has
  its own availability question answered by a `try/except` rather than by a
  person. The skill also separates rate limits from quotas — one protects a
  system and refills continuously, the other protects a budget and does not
  refill until a period rolls over — because a single 429 answering both
  teaches callers to retry against money that will not come back for days.

  The fixture pairs a limiter with the deployment notes that make it wrong: 12
  replicas rising to 40, four rolling deploys a week, a contractual hard spend
  cap, and a Redis that fails over. Support tickets and a finance flag are
  given as symptoms without the diagnosis, and the eval requires the
  arithmetic — 60/minute enforced as 720, and 2,400 at the autoscaler's
  ceiling — rather than a qualitative description of the problem.

- **Skill: `distributed-locking-and-leases`** ([#11]). A lock held across a
  network is a lease, and the one fact the whole skill follows from is that you
  cannot distinguish a dead holder from a slow one. So the lock service cannot
  give you mutual exclusion — it can give you an ordering, and the resource has
  to enforce it. The skill is built around the fence: choosing the lease from
  the timeout you enforce rather than the p99 you measured, keeping the expiry
  on one clock, making release conditional on ownership, checking a backend can
  actually host a lease, and deciding fail-open versus fail-closed explicitly
  rather than by way of a bare `except`.

  The fixture is an incident rather than a toy: a rollup job whose lock was
  held throughout, which re-checks ownership before every write, and which
  still doubled 31 merchants' totals because the holder paused for longer than
  its lease and nothing at the database could tell its write from the new
  holder's. The eval requires that answer and rejects the three that do not
  work — a longer TTL, a heartbeat, and Redlock.

- **Routing collision checks in the validator** ([#9], [#23]). Routing failures
  are the dominant real-world skill bug and the quietest — nothing errors, the
  wrong skill just answers. Two checks now run across the whole catalogue:

  - **Descriptions must stay distinct.** Content-word overlap must stay under
    `0.35`. The threshold was measured on this pack rather than picked:
    legitimate pairs score 0.08–0.10, a deliberately over-broad rewrite scores
    0.48, a reworded duplicate 0.88. All four numbers are pinned in the test
    suite, so a tokeniser change that moves them fails there rather than
    becoming a threshold someone raises to get a green build.
  - **Eval cases must not contradict each other about who owns a prompt.** Two
    skills claiming the same positive trigger, a negative trigger whose `owner`
    another skill contradicts, or a prompt listed as both positive and negative
    for one skill.

- **Negative triggers must name an `owner`** — at least two per case, kebab-case,
  never the skill itself ([#9], [#23]). Without one, a negative trigger records
  that a skill lost a prompt but not who should have won it, and that second
  half is what turns an over-broad description into a visible regression.

- CI badge in the README ([#6], [#22]).

### Documentation

- `evals/README.md` covers the routing checks, the measured threshold, and the
  one thing deliberately left out: a minimum rank-1 rate needs a real routing
  run, which needs a model, which is neither dependency-light nor free in CI.

## [0.1.0] — 2026-08-21

First tagged release. Two of the ten planned skills are complete, each with
eval coverage and a real fixture.

### Skills

- **`idempotency-and-exactly-once`** — retry-safe side effects, dedup stores,
  atomic claims, divergence detection, reconciliation, and retention as a
  correctness parameter rather than a cleanup detail.
- **`failure-mode-analysis`** — enumerating partial failures at design time,
  before the happy path is written: the three-outcome table, blast radius, and
  the degradation ladder.

### References

- **Idempotency review checklist** (`references/idempotency-checklist.md`) — the
  seven verification checks as a standalone pre-merge gate, each item a yes/no
  question with a named piece of evidence, so "considered" cannot pass as an
  answer. Contributed by @shaurya703 in #18.

### Evals

Each skill ships a case under `evals/cases/` with positive triggers, negative
triggers routed to the skill that should own them, and behavioural evals backed
by a fixture under `evals/fixtures/`.

### Compatibility

The format is deliberately compatible with
[`addyosmani/agent-skills`](https://github.com/addyosmani/agent-skills), so
skills developed here can be submitted upstream unchanged.
`idempotency-and-exactly-once` was
[submitted there as PR #479](https://github.com/addyosmani/agent-skills/pull/479)
and merged, passing that repository's full validator suite with zero errors and
zero warnings.

[0.1.0]: https://github.com/abhisheksharma2411/distributed-systems-skills/releases/tag/v0.1.0

[#6]: https://github.com/abhisheksharma2411/distributed-systems-skills/issues/6
[#2]: https://github.com/abhisheksharma2411/distributed-systems-skills/issues/2
[#3]: https://github.com/abhisheksharma2411/distributed-systems-skills/issues/3
[#4]: https://github.com/abhisheksharma2411/distributed-systems-skills/issues/4
[#9]: https://github.com/abhisheksharma2411/distributed-systems-skills/issues/9
[#11]: https://github.com/abhisheksharma2411/distributed-systems-skills/issues/11
[#12]: https://github.com/abhisheksharma2411/distributed-systems-skills/issues/12
[#15]: https://github.com/abhisheksharma2411/distributed-systems-skills/issues/15
[#22]: https://github.com/abhisheksharma2411/distributed-systems-skills/pull/22
[#23]: https://github.com/abhisheksharma2411/distributed-systems-skills/pull/23
