"""Public payouts API, v1.

Serves the partner integrations and the mobile app.
"""

from decimal import Decimal
from enum import Enum

from flask import Blueprint, jsonify, request

from .store import payouts

api = Blueprint("payouts", __name__)

DEFAULT_PAGE_SIZE = 20


class PayoutStatus(str, Enum):
    PENDING = "pending"
    PAID = "paid"
    FAILED = "failed"
    PARTIALLY_PAID = "partially_paid"


def serialize(payout) -> dict:
    return {
        "id": payout.id,
        "status": payout.status.value,
        "amount": str(Decimal(payout.amount_cents) / 100),
        "fee": str(Decimal(payout.fee_cents) / 100),
        "currency": payout.currency,
        "created_at": payout.created_at.isoformat(),
    }


@api.get("/v1/payouts")
def list_payouts():
    limit = int(request.args.get("limit", DEFAULT_PAGE_SIZE))
    rows = payouts.list_for_merchant(
        merchant_id=request.merchant.id,
        limit=limit,
    )
    return jsonify({"payouts": [serialize(p) for p in rows]})


@api.post("/v1/payouts")
def create_payout():
    body = request.get_json()

    currency = body["currency"]
    if currency not in ("USD", "EUR", "GBP"):
        return jsonify({"error": "unsupported_currency"}), 400

    payout = payouts.create(
        merchant_id=request.merchant.id,
        amount_cents=body["amount_cents"],
        currency=currency,
        destination=body["destination"],
    )
    return jsonify(serialize(payout)), 201
