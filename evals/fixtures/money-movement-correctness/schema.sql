-- Merchant wallet schema, as deployed.

CREATE TABLE merchants (
    id              TEXT PRIMARY KEY,
    payout_account  TEXT NOT NULL,
    balance         DOUBLE PRECISION NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE charges (
    id            TEXT PRIMARY KEY,
    merchant_id   TEXT NOT NULL REFERENCES merchants(id),
    provider_ref  TEXT NOT NULL,
    amount        DOUBLE PRECISION NOT NULL,
    refunded      BOOLEAN NOT NULL DEFAULT false,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE settlement_log (
    id             BIGSERIAL PRIMARY KEY,
    merchant_id    TEXT NOT NULL REFERENCES merchants(id),
    settlement_id  TEXT,
    charge_id      TEXT,
    amount         DOUBLE PRECISION NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL
);
