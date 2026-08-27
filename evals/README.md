# Skill evals

Each skill ships an eval case defining what should trigger it, what should *not*, and what an agent following it must actually do.

## Case format

```jsonc
{
  "skill_name": "idempotency-and-exactly-once",
  "trigger": {
    "positive": [ { "prompt": "...", "top_k": 3 } ],
    "negative": [ { "prompt": "...", "owner": "observability-and-instrumentation" } ]
  },
  "evals": [
    {
      "id": 1,
      "prompt": "...",
      "expected_output": "...",
      "files": ["idempotency-and-exactly-once"],
      "expectations": ["...", "..."]
    }
  ]
}
```

**Positive triggers** are prompts a user would realistically type; the skill should rank in the top *k*. **Negative triggers** are prompts that belong to a different skill — `owner` names which one, so a description that grows too broad is caught as a routing regression rather than a vague quality complaint.

**Behavioral evals** grade what an agent *did*, not what it said. `files` names a fixture directory under `evals/fixtures/`; `expectations[]` is the rubric.

## Minimums

Enforced by `scripts/validate-skills.js`, which CI runs on every pull request.

- ≥ 3 positive triggers
- ≥ 2 negative triggers **naming an `owner`** — kebab-case, and never this skill
- ≥ 1 behavioral eval with a populated `expectations[]`
- Every execution eval backed by real files under `evals/fixtures/<skill-name>/`

An `owner` may name a skill outside this pack (`observability-and-instrumentation`
is one we use), so it is checked for shape rather than existence. Without one, a
negative trigger records that this skill lost a prompt but not who should have
won it — and that second half is what turns an over-broad description into a
visible regression rather than a vague complaint.

## Routing collisions

With two skills there is nothing to collide with. Around five, descriptions
start overlapping — `resilience-patterns` and `failure-mode-analysis` both
legitimately match *"what happens when this dependency goes down"*. Routing
failures are the dominant real-world skill bug and the quietest: nothing errors,
the wrong skill just answers.

Two checks run across the whole catalogue, not per file, because that is where
the contradiction lives:

**Descriptions must stay distinct.** Content-word overlap (Jaccard, stop words
and the shared `Use when` / `NOT for` scaffolding removed) must stay below
`0.35`. The number was measured on this pack, not picked:

| pair | overlap | |
|---|---|---|
| `failure-mode-analysis` vs `idempotency-and-exactly-once` | 0.10 | distinct |
| `failure-mode-analysis` vs a drafted `resilience-patterns` | 0.08 | sibling domain |
| `failure-mode-analysis` vs a deliberately over-broad rewrite | 0.48 | the bug |
| `failure-mode-analysis` vs itself, lightly reworded | 0.88 | duplicate |

0.35 sits in the gap: three times the widest legitimate overlap, and clear of
the over-broad case. All four numbers are pinned in
`scripts/validate-skills-test.js`, so a change to the tokeniser that moves them
fails there rather than becoming a threshold someone raises to get a green build.

**Cases must not contradict each other about who owns a prompt.** A negative
trigger with an `owner` is an assertion about where a prompt routes, and two
cases can assert incompatible things — which is invisible in either file alone:

- the same prompt is a positive trigger for two skills (both cannot rank first)
- a prompt is a negative trigger of A naming owner `C`, while B claims it as a
  positive trigger
- a prompt is both a positive and a negative trigger of the same skill

The healthy shape is the opposite: skill B lists a prompt as negative with
`owner: "alpha"`, and alpha lists it as a positive trigger. That agreement is
what makes a routing regression detectable.

### Not yet enforced

A minimum rank-1 rate needs an actual routing run, which needs a model, which is
neither dependency-light nor free in CI. The checks above are the static half —
they catch descriptions and cases that *cannot* route correctly, not ones that
merely *do not*.

## Fixtures

A fixture must contain the **actual defect** the skill exists to catch, in code that looks like something a competent engineer would plausibly write. A fixture whose bug is obvious proves nothing — the defects worth catching are the ones that read as correct.

`fixtures/idempotency-and-exactly-once/` is the reference example: a payout handler with a per-attempt `uuid4()` key, a check-then-act sequence wrapped around a real transfer, and an accumulative balance update, plus a context file describing the retry, dead-letter-replay, and concurrent-worker paths that make all three reachable.

## Compatibility

This format matches [`addyosmani/agent-skills`](https://github.com/addyosmani/agent-skills), whose `scripts/run-evals.js` can execute these cases directly. Skills developed here can be submitted upstream without restructuring.
