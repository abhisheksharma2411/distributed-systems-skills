---
name: api-compatibility-and-versioning
description: Evolves a published interface without breaking the callers already running against it, covering additive change, deprecation windows, and the observable behaviour consumers depend on whether or not it was promised. Use when changing a response shape, tightening validation, adding an enum value, altering a default, or removing something analytics says is unused. Use when planning a deprecation or deciding whether a change needs a new version. Use when a partner integration broke after a release that passed every test.
---

# API Compatibility and Versioning

## Overview

A breaking API change does not look like one. It passes the test suite, because the test suite was written by the people who own the producer and it asserts what the producer meant. It breaks a consumer weeks later, on a code path nobody here has read, in an application nobody here can deploy.

The governing idea is **Hyrum's Law**: with enough consumers, every observable behaviour of your interface is depended on by somebody, regardless of what the contract says. Field ordering, the exact error string, how many results come back when no limit is passed, whether a number arrives as `3` or `"3.00"` — if it can be observed, something is parsing it.

That does not mean nothing can ever change. It means **the contract is not the schema; the contract is what consumers can observe, and changing it is a release event rather than a patch.**

The second idea is that compatibility is directional and there are two of them. *Backward* compatible: new server, old client — the usual concern. *Forward* compatible: old server, new client — which is what a rolling deploy and every rollback actually require.

## When to Use

- Changing a response shape: adding, removing, renaming, reordering, or retyping a field
- Adding a value to an enum, or a new variant to a union a consumer switches on
- Tightening validation, or changing what happens when an optional parameter is absent
- Changing a default — page size, sort order, currency rounding, timeout
- Removing an endpoint, parameter or field that instrumentation says is unused
- Planning a deprecation window, or deciding whether a change earns a new version
- Investigating a partner or mobile integration that broke after a release that passed CI

Not for: designing an interface that has no consumers yet, internal refactors behind a boundary nothing outside calls, or changing the *data* shape underneath rather than the published contract, which is a schema migration and a different problem.

## Process

### 1. Establish who is actually calling, and how long they live

Before classifying the change, answer: which consumers exist, which versions are live, and what is the longest one will stay live? The answer is rarely "everyone upgrades on Friday".

A mobile client has a tail measured in months and a floor set by the slowest app-store review and the users who never update. A partner integration has a tail measured in contracts. An internal service has a tail measured in how long its team takes to prioritise your email.

**That tail is the deprecation window.** It is a fact to be discovered, not a policy to be chosen.

### 2. Classify the change by what a consumer observes, not by the diff

- **Additive** — a new optional field, a new optional parameter, a new endpoint. Safe *if* consumers tolerate unknown fields, which is an assumption to verify rather than assert.
- **Breaking** — removing or renaming, retyping, making an optional thing required, tightening validation, changing a default, or changing the meaning of an existing value.
- **Breaking in disguise** — the dangerous class. A change that is additive in the schema and breaking in practice.

The disguised ones are worth naming individually, because each has shipped under a "non-breaking" label somewhere:

- **A new enum value.** The schema grew; every consumer with an exhaustive `switch` or a validating deserializer now fails on a value it has never seen. Adding to an enum a consumer reads is a breaking change unless they were explicitly told to expect it.
- **A tightened validator.** Requests that used to succeed now 400. The contract never promised lowercase currency codes were allowed, but it accepted them for two years, so something is sending them.
- **A changed default.** Clients that pass nothing silently receive something different. No error, no signal — a report quietly truncates to 20 rows.
- **A retyped field.** `3` becoming `"3.00"` breaks every consumer that does arithmetic on it, and the schema may well call both "fee".

### 3. Treat "analytics says nobody uses it" as a measurement with known blind spots

Before removing anything, ask what the instrumentation can actually see. It usually cannot see consumers who read a field without triggering a distinct request, traffic from partners routed through a gateway that aggregates, clients that fetch the whole object and parse one field out, or anything that only runs quarterly.

Absence of observed use is evidence; it is not proof of absence of use, and the gap between those is exactly where this fails. If removal is going ahead on that basis, say so explicitly in the plan — *we are removing this on telemetry that cannot see X* — so the risk is a decision rather than an assumption.

### 4. Expand, then deprecate, then remove — and the window is not a countdown

The same shape as a data migration, for the same reason:

- **Expand** — add the new field, parameter or endpoint alongside the old. Both work. Neither is required.
- **Deprecate** — announce it, instrument it, and tell the remaining callers *by name*. A deprecation nobody was told about is a removal with a delay in front of it.
- **Remove** — only once the instrumentation shows the old path is actually unused, and the known long-tail consumers have confirmed.

A window that expires while traffic is still arriving has not expired. The date was an estimate of when callers would migrate; the traffic is the measurement. Removing on the date anyway converts a scheduling problem into an outage.

### 5. Make the rollback direction work too

A rolling deploy runs both versions at once, and a rollback runs the old one against data the new one wrote. So the old version must tolerate what the new one produces: unknown fields ignored rather than rejected, unknown enum values falling back rather than crashing, new records readable.

This is forward compatibility, and it is usually the one nobody tested — the deploy is rehearsed, the rollback is not. If the old version cannot read what the new version writes, there is no rollback, only a restore.

### 6. Version when the change cannot be made compatible, and know what that costs

A new version is not the default answer; it is the escape hatch for a change that genuinely cannot be expressed additively. It is also not free: every version is a code path that must be maintained, tested, and eventually deprecated through this same process.

Whatever the mechanism — URL path, media type, header — the thing that matters is that the old behaviour keeps working unchanged for its full window. A "version" that quietly alters the old version's behaviour is a breaking change with extra steps.

## Common Rationalizations

| Excuse | Reality |
|---|---|
| "It's additive, so it's not breaking" | Additive in the schema; a new enum value breaks every exhaustive switch and strict deserializer reading it. |
| "Nobody uses that field, analytics confirms it" | Analytics sees requests, not which fields of the response were parsed. The partner who reads it never generates a distinct call. |
| "The contract never promised that" | Hyrum's Law. It was observable for two years, so it is depended on, and the consumer did not read your contract. |
| "We gave them six months' notice" | Notice is not migration. If traffic is still arriving, the window measured the calendar rather than the callers. |
| "It's just a stricter validation, the old inputs were invalid" | They were accepted. Accepted is the contract. Rejecting them is a breaking change on your timeline, not theirs. |
| "Clients should ignore unknown fields" | Should is not do. Whether they do is a property to verify against real consumers, not a requirement to assert at them. |
| "We'll bump the version if anyone complains" | The complaint arrives as a partner incident, after the breakage, with their customers already affected. |
| "Mobile will have updated by then" | There is no "by then" for an app the user has not opened. The tail is set by the slowest user, not the release schedule. |

## Red Flags

- A PR adding an enum value with no note on how consumers deserialize it
- A field removed on the strength of dashboard telemetry, with no partner named or asked
- Validation tightened in the same release that adds a feature, so the rejection looks like the feature's fault
- A default changed in a PR described as a tuning or performance change
- A deprecation window defined only by a date, with no traffic measurement attached
- A rollback plan that has never been run against records written by the new version
- "Backward compatible" in a PR description with no statement of which consumers were checked
- A new API version introduced alongside a behaviour change to the *previous* version

## Verification

- [ ] Every live consumer class is listed, with the longest realistic tail for each — not an assumed upgrade date
- [ ] The change is classified against what a consumer can observe, and any disguised-breaking case is named explicitly
- [ ] New enum values are checked against how each consumer deserializes: exhaustive switch, strict parser, or tolerant fallback
- [ ] Nothing is removed on telemetry alone unless the plan states what that telemetry cannot see
- [ ] Deprecated paths are instrumented, and removal is gated on observed traffic reaching zero rather than on a date
- [ ] Named long-tail consumers have been contacted directly, not just sent a changelog entry
- [ ] The previous version has been run against records the new version wrote, so rollback is known to work
- [ ] If a new version was created, the old one's behaviour is byte-for-byte unchanged for its full window
