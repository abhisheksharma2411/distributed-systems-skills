"""Checkout handler.

Called by the storefront API. The gateway in front of this times out at 30s.
"""

import requests

from .db import db


def checkout(cart, customer):
    inventory = requests.post(
        "https://inventory.internal/reserve",
        json={"items": cart.items},
    )
    reservation = inventory.json()["reservation_id"]

    charge = requests.post(
        "https://api.payments.example/charges",
        json={"customer": customer.id, "amount_cents": cart.total_cents},
        timeout=60,
    )

    order_id = db.execute(
        "INSERT INTO orders (customer_id, reservation_id, charge_id, total_cents) "
        "VALUES (%s, %s, %s, %s) RETURNING id",
        (customer.id, reservation, charge.json()["id"], cart.total_cents),
    )

    requests.post(
        "https://api.email.example/send",
        json={"to": customer.email, "template": "order_confirmation", "order": order_id},
    )

    return {"order_id": order_id, "status": "confirmed"}
