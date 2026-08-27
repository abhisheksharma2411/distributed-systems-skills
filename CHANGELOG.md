# Changelog

Notable changes to this skill pack.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions track the catalogue: a minor bump adds or materially reworks a skill.

## [Unreleased]

### Added

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
[#9]: https://github.com/abhisheksharma2411/distributed-systems-skills/issues/9
[#22]: https://github.com/abhisheksharma2411/distributed-systems-skills/pull/22
[#23]: https://github.com/abhisheksharma2411/distributed-systems-skills/pull/23
