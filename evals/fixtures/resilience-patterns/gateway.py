"""Outbound integrations for the checkout service.

One shared HTTP session for all of them. The retry decorator was added after
INC-1902 (transient 502s from the pricing service during their deploys).
"""

import time

import requests

from .config import settings

# Shared across every integration below.
session = requests.Session()
session.mount("https://", requests.adapters.HTTPAdapter(pool_maxsize=32))

BACKOFF_BASE = 0.5


def retry(attempts=3):
    def decorate(fn):
        def wrapper(*args, **kwargs):
            last = None
            for attempt in range(attempts):
                try:
                    return fn(*args, **kwargs)
                except Exception as exc:  # noqa: BLE001
                    last = exc
                    time.sleep(BACKOFF_BASE * 2**attempt)
            raise last

        return wrapper

    return decorate


@retry(attempts=3)
def get_price(sku: str) -> int:
    r = session.get(f"{settings.PRICING_URL}/price/{sku}")
    r.raise_for_status()
    return r.json()["cents"]


@retry(attempts=3)
def charge_card(customer_id: str, amount_cents: int) -> dict:
    r = session.post(
        f"{settings.PAYMENTS_URL}/charges",
        json={"customer": customer_id, "amount": amount_cents},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


@retry(attempts=3)
def send_receipt(customer_id: str, charge_id: str) -> None:
    r = session.post(
        f"{settings.NOTIFY_URL}/receipts",
        json={"customer": customer_id, "charge": charge_id},
    )
    r.raise_for_status()


def recommendations(customer_id: str) -> list:
    """Best-effort upsell block on the confirmation page."""
    r = session.get(f"{settings.RECS_URL}/for/{customer_id}")
    return r.json()["items"] if r.ok else []
