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

- ≥ 3 positive triggers
- ≥ 2 negative triggers, each with an `owner` where a real owner exists
- ≥ 1 behavioral eval with a populated `expectations[]`
- Every execution eval backed by real files under `evals/fixtures/<skill-name>/`

## Fixtures

A fixture must contain the **actual defect** the skill exists to catch, in code that looks like something a competent engineer would plausibly write. A fixture whose bug is obvious proves nothing — the defects worth catching are the ones that read as correct.

`fixtures/idempotency-and-exactly-once/` is the reference example: a payout handler with a per-attempt `uuid4()` key, a check-then-act sequence wrapped around a real transfer, and an accumulative balance update, plus a context file describing the retry, dead-letter-replay, and concurrent-worker paths that make all three reachable.

## Compatibility

This format matches [`addyosmani/agent-skills`](https://github.com/addyosmani/agent-skills), whose `scripts/run-evals.js` can execute these cases directly. Skills developed here can be submitted upstream without restructuring.
