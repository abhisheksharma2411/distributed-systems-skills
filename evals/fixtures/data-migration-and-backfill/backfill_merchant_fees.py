"""Backfill `fee_cents` onto settlements from the legacy `fee_bps` column.

Run as a one-off job:  python backfill_merchant_fees.py
"""

import logging

from db import db

log = logging.getLogger(__name__)

BATCH = 500


def backfill() -> int:
    """Fill fee_cents for every settlement that does not have one yet."""
    total = 0
    while True:
        rows = db.query(
            "SELECT id, amount_cents, fee_bps FROM settlements "
            "WHERE fee_cents IS NULL LIMIT %s",
            (BATCH,),
        )
        if not rows:
            break

        for row in rows:
            fee = round(row["amount_cents"] * row["fee_bps"] / 10_000)
            db.execute(
                "UPDATE settlements SET fee_cents = %s WHERE id = %s",
                (fee, row["id"]),
            )
            db.execute(
                "UPDATE merchant_totals SET fees_collected = fees_collected + %s "
                "WHERE merchant_id = %s",
                (fee, row["merchant_id"]),
            )

        total += len(rows)
        log.info("backfilled %s settlements", total)

    return total


def verify() -> bool:
    """Spot-check that the new column agrees with the old one."""
    sample = db.query(
        "SELECT amount_cents, fee_bps, fee_cents FROM settlements "
        "ORDER BY RANDOM() LIMIT 1000"
    )
    for row in sample:
        expected = round(row["amount_cents"] * row["fee_bps"] / 10_000)
        if row["fee_cents"] != expected:
            log.error("mismatch on settlement, aborting")
            return False
    return True


if __name__ == "__main__":
    count = backfill()
    log.info("backfilled %s rows", count)
    if verify():
        db.execute("ALTER TABLE settlements DROP COLUMN fee_bps")
        log.info("dropped legacy column")
