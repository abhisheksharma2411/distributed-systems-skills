"""Merchant wallet: settlements in, payouts out, refunds and chargebacks.

The balance column is the number shown in the merchant dashboard and the one
the payout job reads.
"""

from decimal import Decimal

from .db import db
from .provider import provider


def credit_settlement(merchant_id: str, amount: float, settlement_id: str) -> None:
    db.execute(
        "UPDATE merchants SET balance = balance + %s WHERE id = %s",
        (amount, merchant_id),
    )
    db.execute(
        "INSERT INTO settlement_log (merchant_id, settlement_id, amount, created_at) "
        "VALUES (%s, %s, %s, now())",
        (merchant_id, settlement_id, amount),
    )


def refund(charge_id: str, amount: float) -> None:
    charge = db.query_one("SELECT * FROM charges WHERE id = %s", (charge_id,))
    provider.refund(charge["provider_ref"], amount)
    db.execute(
        "UPDATE charges SET amount = amount - %s, refunded = true WHERE id = %s",
        (amount, charge_id),
    )
    db.execute(
        "UPDATE merchants SET balance = balance - %s WHERE id = %s",
        (amount, charge["merchant_id"]),
    )


def apply_chargeback(charge_id: str) -> None:
    charge = db.query_one("SELECT * FROM charges WHERE id = %s", (charge_id,))
    db.execute("DELETE FROM settlement_log WHERE charge_id = %s", (charge_id,))
    db.execute(
        "UPDATE merchants SET balance = balance - %s WHERE id = %s",
        (charge["amount"], charge["merchant_id"]),
    )


def payout(merchant_id: str) -> None:
    merchant = db.query_one("SELECT * FROM merchants WHERE id = %s", (merchant_id,))
    if merchant["balance"] <= 0:
        return
    provider.payout(merchant["payout_account"], merchant["balance"])
    db.execute("UPDATE merchants SET balance = 0 WHERE id = %s", (merchant_id,))


def reconcile(window_start: str, window_end: str) -> None:
    """Nightly: align our numbers with the provider's statement."""
    for line in provider.statement(window_start, window_end):
        local = db.query_one(
            "SELECT * FROM settlement_log WHERE settlement_id = %s", (line["id"],)
        )
        if local is None:
            db.execute(
                "INSERT INTO settlement_log (merchant_id, settlement_id, amount, created_at) "
                "VALUES (%s, %s, %s, now())",
                (line["merchant_id"], line["id"], line["amount"]),
            )
        elif Decimal(str(local["amount"])) != Decimal(str(line["amount"])):
            db.execute(
                "UPDATE settlement_log SET amount = %s WHERE settlement_id = %s",
                (line["amount"], line["id"]),
            )
