"""Partner payout handler.

Called by the payouts worker, which retries on any non-2xx response from the
provider and also replays the queue's dead-letter batch each morning.
"""

import uuid

from .db import db
from .provider import provider


def issue_payout(partner_id: str, amount_cents: int) -> dict:
    key = str(uuid.uuid4())

    if not db.exists("payout_keys", key):
        result = provider.transfer(
            destination=partner_id,
            amount=amount_cents,
        )
        db.insert("payout_keys", key)
        db.execute(
            "UPDATE partner_balances SET paid_cents = paid_cents + %s WHERE partner_id = %s",
            (amount_cents, partner_id),
        )
        return result

    return {"status": "already_processed"}
