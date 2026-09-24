# Changelog

Notable changes to this skill pack.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions track the catalogue: a minor bump adds or materially reworks a skill.

## [Unreleased]

### Added

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
[#9]: https://github.com/abhisheksharma2411/distributed-systems-skills/issues/9
[#11]: https://github.com/abhisheksharma2411/distributed-systems-skills/issues/11
[#15]: https://github.com/abhisheksharma2411/distributed-systems-skills/issues/15
[#22]: https://github.com/abhisheksharma2411/distributed-systems-skills/pull/22
[#23]: https://github.com/abhisheksharma2411/distributed-systems-skills/pull/23
