"""Payout worker.

Each worker claims a batch of pending payouts, holds the claim for the length
of the lease, submits them to the provider, then releases. Runs as 8 replicas
in two regions.
"""

from __future__ import annotations

import datetime
import time
import uuid

import psycopg

LEASE_SECONDS = 120
SUBMIT_TIMEOUT_SECONDS = 30

WORKER_ID = str(uuid.uuid4())


def claim_batch(conn: psycopg.Connection, limit: int = 50) -> list[dict]:
    """Take the lease on up to `limit` pending payouts.

    The lease is how we guarantee two workers never submit the same payout.
    """
    expires_at = time.time() + LEASE_SECONDS
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE payouts
               SET leased_by = %s,
                   leased_until = %s
             WHERE id IN (
                   SELECT id FROM payouts
                    WHERE state = 'PENDING'
                      AND (leased_until IS NULL OR leased_until < %s)
                    LIMIT %s
                   FOR UPDATE SKIP LOCKED
             )
         RETURNING id, amount_minor, currency, destination
            """,
            (WORKER_ID, expires_at, time.time(), limit),
        )
        rows = cur.fetchall()
    conn.commit()
    return [
        {"id": r[0], "amount_minor": r[1], "currency": r[2], "destination": r[3]}
        for r in rows
    ]


def lease_remaining(leased_until: float) -> float:
    """Seconds left on our lease. Never negative."""
    return max(0.0, leased_until - time.time())


def submit_batch(conn: psycopg.Connection, payouts: list[dict], leased_until: float) -> None:
    for payout in payouts:
        if lease_remaining(leased_until) < SUBMIT_TIMEOUT_SECONDS:
            # Not enough lease left to finish this one safely; leave it for
            # the next worker.
            break

        started = time.time()
        reference = provider.submit(
            amount_minor=payout["amount_minor"],
            currency=payout["currency"],
            destination=payout["destination"],
            timeout=SUBMIT_TIMEOUT_SECONDS,
        )
        elapsed = time.time() - started
        metrics.observe("payout.submit.seconds", elapsed)

        with conn.cursor() as cur:
            cur.execute(
                "UPDATE payouts SET state = 'SENT', reference = %s, sent_at = %s WHERE id = %s",
                (reference, datetime.datetime.now(), payout["id"]),
            )
        conn.commit()


def next_settlement_run() -> datetime.datetime:
    """Settlement runs every day at 09:00 in the treasury team's local time."""
    now = datetime.datetime.now()
    today_at_nine = now.replace(hour=9, minute=0, second=0, microsecond=0)
    if now < today_at_nine:
        return today_at_nine
    return today_at_nine + datetime.timedelta(seconds=86400)


def latest_state(conn: psycopg.Connection, payout_id: str) -> str:
    """The payout's current state, taking the most recently written row."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT state FROM payout_events
             WHERE payout_id = %s
             ORDER BY created_at DESC
             LIMIT 1
            """,
            (payout_id,),
        )
        return cur.fetchone()[0]


def run_forever(conn: psycopg.Connection) -> None:
    while True:
        leased_until = time.time() + LEASE_SECONDS
        batch = claim_batch(conn)
        if not batch:
            time.sleep(5)
            continue
        submit_batch(conn, batch, leased_until)
