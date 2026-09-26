package payouts

import (
	"context"
	"crypto/rand"
	"database/sql"
	"fmt"
	"time"
)

type Transfer struct {
	ID     string
	Status string
}

type Provider interface {
	Transfer(ctx context.Context, destination string, amountCents int64) (Transfer, error)
}

func ProcessPayout(ctx context.Context, db *sql.DB, provider Provider, partnerID string, amountCents int64) (Transfer, error) {
	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		transfer, err := IssuePayout(ctx, db, provider, partnerID, amountCents)
		if err == nil {
			return transfer, nil
		}
		lastErr = err
		if attempt < 2 {
			select {
			case <-ctx.Done():
				return Transfer{}, fmt.Errorf("payout canceled: %w", ctx.Err())
			case <-time.After(time.Duration(attempt+1) * 100 * time.Millisecond):
			}
		}
	}
	return Transfer{}, fmt.Errorf("payout failed after three attempts: %w", lastErr)
}

func IssuePayout(ctx context.Context, db *sql.DB, provider Provider, partnerID string, amountCents int64) (Transfer, error) {
	var id [16]byte
	if _, err := rand.Read(id[:]); err != nil {
		return Transfer{}, fmt.Errorf("generate payout key: %w", err)
	}
	id[6] = (id[6] & 0x0f) | 0x40
	id[8] = (id[8] & 0x3f) | 0x80
	key := fmt.Sprintf("%x-%x-%x-%x-%x", id[0:4], id[4:6], id[6:8], id[8:10], id[10:16])

	var exists bool
	if err := db.QueryRowContext(ctx, "SELECT EXISTS (SELECT 1 FROM payout_keys WHERE key = $1)", key).Scan(&exists); err != nil {
		return Transfer{}, fmt.Errorf("check payout key: %w", err)
	}
	if exists {
		return Transfer{Status: "already_processed"}, nil
	}

	transfer, err := provider.Transfer(ctx, partnerID, amountCents)
	if err != nil {
		return Transfer{}, fmt.Errorf("transfer payout: %w", err)
	}
	if _, err := db.ExecContext(ctx, "INSERT INTO payout_keys (key) VALUES ($1)", key); err != nil {
		return Transfer{}, fmt.Errorf("record payout key: %w", err)
	}
	if _, err := db.ExecContext(ctx,
		"UPDATE partner_balances SET paid_cents = paid_cents + $1 WHERE partner_id = $2",
		amountCents, partnerID,
	); err != nil {
		return Transfer{}, fmt.Errorf("update partner balance: %w", err)
	}
	return transfer, nil
}
