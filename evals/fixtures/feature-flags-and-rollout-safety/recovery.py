"""Invoice recovery: schedule a retry, then execute it.

The two halves run in different processes. `plan_retry` runs in the scheduler
when an invoice fails; `execute_retry` runs in a worker when the scheduled time
arrives, typically four to thirty hours later.

We are currently running an A/B test between the old decider and the new
hybrid ladder, ramping from 5% to 50% over three weeks.
"""

from __future__ import annotations

import hashlib

from . import flags, ladder, metrics, tokens


def plan_retry(invoice) -> None:
    """Choose a retry time for a failed invoice."""
    ab_enabled = flags.is_enabled("recovery_ab_test")
    adaptive_enabled = flags.is_enabled("adaptive_retry")

    if ab_enabled:
        arm = _assign_arm(invoice.id)
        invoice.recovery_arm = arm
        use_hybrid = arm == "hybrid" or adaptive_enabled
    else:
        use_hybrid = adaptive_enabled

    if use_hybrid:
        invoice.next_attempt_at = ladder.hybrid_schedule(invoice)
    else:
        invoice.next_attempt_at = ladder.decider_schedule(invoice)

    invoice.save()
    metrics.increment("recovery.planned", tags={"hybrid": str(use_hybrid)})


def execute_retry(invoice) -> None:
    """Submit the retry the scheduler planned."""
    # Same flags the scheduler resolved.
    ab_enabled = flags.is_enabled("recovery_ab_test")
    adaptive_enabled = flags.is_enabled("adaptive_retry")

    use_hybrid = ab_enabled or adaptive_enabled

    token = tokens.for_invoice(invoice, hybrid=use_hybrid)
    result = provider.charge(invoice.amount_minor, token)

    metrics.increment(
        "recovery.executed",
        tags={"hybrid": str(use_hybrid), "outcome": result.status},
    )
    invoice.record_attempt(result)


def _assign_arm(invoice_id: str) -> str:
    """Put the invoice in an arm. 50/50 within whatever share is ramped in."""
    digest = hashlib.sha256(invoice_id.encode()).hexdigest()
    return "hybrid" if int(digest[:8], 16) % 2 == 0 else "decider"


def is_recovery_enabled_for(customer) -> bool:
    """Whether recovery runs at all for this customer."""
    try:
        return flags.is_enabled("recovery_enabled", customer_id=customer.id)
    except Exception:
        # Don't block recovery because the flag service is having a bad day.
        return True
