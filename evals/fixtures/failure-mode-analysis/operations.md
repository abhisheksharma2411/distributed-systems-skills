# Checkout operations

The storefront API gateway times out client requests at **30 seconds**.

The payment provider is a third party. A charge is irreversible without an
explicit refund call, and support for idempotency keys is available but not
currently used.

The inventory service is internal and is redeployed several times a day; pods
are restarted mid-request during a rollout.

The email provider is best-effort — a missing confirmation is a support
ticket, not an incident. A duplicate confirmation is also a support ticket.
