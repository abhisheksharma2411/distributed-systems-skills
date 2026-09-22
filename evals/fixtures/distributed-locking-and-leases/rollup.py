"""Nightly merchant rollup.

Runs on every app replica from cron at 02:00. The lock is there because two
replicas running the rollup double the totals, which finance notices at month
end rather than that night.
"""

import time

from .db import db
from .redis_client import redis

LOCK_KEY = "lock:nightly-rollup"
LEASE_SECONDS = 120  # p99 of the rollup is ~35s, so this is generous


def acquire(key: str) -> bool:
    """Take the lock if nobody holds it."""
    if redis.exists(key):
        return False
    redis.set(key, "held", ex=LEASE_SECONDS)
    return True


def release(key: str) -> None:
    redis.delete(key)


def run_nightly_rollup(day: str) -> None:
    if not acquire(LOCK_KEY):
        return

    lease_expires_at = time.time() + LEASE_SECONDS
    try:
        for merchant_id, amount_cents in db.query(
            "SELECT merchant_id, amount_cents FROM settlements WHERE day = %s", (day,)
        ):
            # Still ours?
            if time.time() > lease_expires_at:
                raise RuntimeError("lease expired")

            db.execute(
                """
                INSERT INTO merchant_rollups (merchant_id, day, total_cents)
                VALUES (%s, %s, %s)
                ON CONFLICT (merchant_id, day)
                DO UPDATE SET total_cents = merchant_rollups.total_cents + EXCLUDED.total_cents
                """,
                (merchant_id, day, amount_cents),
            )

        db.execute(
            "UPDATE rollup_runs SET status = 'done', finished_at = now() WHERE day = %s",
            (day,),
        )
    finally:
        release(LOCK_KEY)
