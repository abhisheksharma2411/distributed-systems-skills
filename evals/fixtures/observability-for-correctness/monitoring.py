"""Metrics and alerting for the payouts service.

Dashboard: `payouts / health`. Panels are built from these metrics.
"""

from prometheus_client import Counter, Gauge, Histogram

request_latency = Histogram("payout_request_seconds", "API latency", ["endpoint"])
requests_total = Counter("payout_requests_total", "Requests", ["endpoint", "status"])
errors_total = Counter("payout_errors_total", "Unhandled exceptions", ["endpoint"])
outbox_depth = Gauge("payout_outbox_depth", "Rows in the outbox")
worker_up = Gauge("payout_worker_up", "1 if the worker process is alive")


def refresh_gauges(db) -> None:
    """Scraped every 30s."""
    outbox_depth.set(
        db.scalar("SELECT count(*) FROM outbox WHERE published_at IS NULL")
    )
    worker_up.set(1)


def reconcile_with_provider(db, provider) -> None:
    """Nightly at 02:00, via cron. Compares our payouts against the provider's."""
    ours = db.query("SELECT provider_ref, amount_cents FROM payouts WHERE status = 'SENT'")
    theirs = provider.list_payouts(since="yesterday")

    discrepancies = 0
    for row in ours:
        match = theirs.get(row["provider_ref"])
        if match is None or match["amount_cents"] != row["amount_cents"]:
            discrepancies += 1

    if discrepancies:
        alert.page(f"payout reconciliation found {discrepancies} discrepancies")
    # Nothing is emitted when discrepancies == 0.


def mark_sent(db, payout_id: str, provider_ref: str) -> None:
    with db.begin():
        db.execute(
            "UPDATE payouts SET status = 'SENT', provider_ref = %s WHERE id = %s",
            (provider_ref, payout_id),
        )
        db.execute(
            "INSERT INTO ledger_entries (payout_id, account, amount_cents) "
            "VALUES (%s, 'payouts_payable', %s), (%s, 'cash', %s)",
            (payout_id, -1, payout_id, 1),
        )
