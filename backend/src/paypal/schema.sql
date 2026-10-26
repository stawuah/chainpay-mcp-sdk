-- Only applied by the isolated PayPal store to a chainpay_paypal_* database.
CREATE TABLE IF NOT EXISTS paypal_sessions (
    token_hash TEXT PRIMARY KEY,
    principal TEXT NOT NULL,
    workspace TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('buyer', 'merchant', 'agent')),
    expires_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS paypal_tasks (
    id TEXT PRIMARY KEY,
    workspace TEXT NOT NULL,
    principal TEXT NOT NULL,
    request_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    record JSONB NOT NULL,
    created_at BIGINT NOT NULL,
    UNIQUE (workspace, principal, request_id)
);
CREATE TABLE IF NOT EXISTS paypal_webhook_inbox (
    id TEXT PRIMARY KEY,
    event JSONB NOT NULL,
    received_at BIGINT NOT NULL,
    processed_at BIGINT
);
CREATE TABLE IF NOT EXISTS paypal_rate_windows (
    identity TEXT NOT NULL,
    window_id BIGINT NOT NULL,
    count INTEGER NOT NULL,
    PRIMARY KEY (identity, window_id)
);

ALTER TABLE paypal_webhook_inbox ADD COLUMN IF NOT EXISTS attempted_at BIGINT;

-- Isolated subscription access; cash payment evidence is not an Orders capture.
CREATE TABLE IF NOT EXISTS paypal_subscriptions (
 id TEXT PRIMARY KEY, workspace TEXT NOT NULL, buyer TEXT NOT NULL,
 request_id TEXT NOT NULL, record JSONB NOT NULL, UNIQUE(workspace,buyer,request_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS paypal_subscription_provider ON paypal_subscriptions((record->>'provider_id'));
CREATE TABLE IF NOT EXISTS paypal_subscription_periods (
 subscription_id TEXT NOT NULL REFERENCES paypal_subscriptions(id), start_at BIGINT NOT NULL,
 end_at BIGINT NOT NULL, payment_id TEXT UNIQUE, remaining INTEGER NOT NULL DEFAULT 0 CHECK(remaining BETWEEN 0 AND 10),
 blocked BOOLEAN NOT NULL DEFAULT FALSE, PRIMARY KEY(subscription_id,start_at)
);
CREATE TABLE IF NOT EXISTS paypal_delegations (
 id TEXT PRIMARY KEY, subscription_id TEXT NOT NULL REFERENCES paypal_subscriptions(id), record JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS paypal_allowance_ledger (
 entry_key TEXT PRIMARY KEY, subscription_id TEXT NOT NULL, period_start BIGINT NOT NULL,
 task_id TEXT, delegation_id TEXT, kind TEXT NOT NULL, units INTEGER NOT NULL, created_at BIGINT NOT NULL
);

-- Hot lookups on JSONB fields: the public receipt by share token, webhook
-- matching by provider ids, the pending-event scan, and allowance checks.
-- paypal_tasks indexes come last (see the end of this file).
CREATE INDEX IF NOT EXISTS paypal_webhook_inbox_pending ON paypal_webhook_inbox(received_at) WHERE processed_at IS NULL;
CREATE INDEX IF NOT EXISTS paypal_allowance_ledger_delegation ON paypal_allowance_ledger(delegation_id, period_start, kind);

-- Buyer allowances for catalog purchases. Spend is the sum of reserve rows
-- minus release rows; refunds never write a release.
CREATE TABLE IF NOT EXISTS paypal_allowances (
 id TEXT PRIMARY KEY, workspace TEXT NOT NULL, buyer TEXT NOT NULL, request_id TEXT NOT NULL,
 record JSONB NOT NULL, created_at BIGINT NOT NULL, UNIQUE(workspace,buyer,request_id)
);
CREATE INDEX IF NOT EXISTS paypal_allowances_workspace ON paypal_allowances(workspace, created_at DESC);
CREATE TABLE IF NOT EXISTS paypal_allowance_spend (
 entry_key TEXT PRIMARY KEY, allowance_id TEXT NOT NULL REFERENCES paypal_allowances(id), task_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK (kind IN ('reserve','release')), cents BIGINT NOT NULL CHECK (cents >= 0), created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS paypal_allowance_spend_allowance ON paypal_allowance_spend(allowance_id, created_at);
CREATE TABLE IF NOT EXISTS paypal_disputes (
 id TEXT PRIMARY KEY, workspace TEXT NOT NULL, task_id TEXT NOT NULL, capture_id TEXT NOT NULL,
 record JSONB NOT NULL, updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS paypal_disputes_workspace ON paypal_disputes(workspace, updated_at DESC);

-- A confirmed refund on an allowance purchase writes a 'refund' row
-- (entry_key refund:<provider refund id>) as audit history only. It never
-- replenishes lifetime spend or writes a release. Widens the kind check once.
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='paypal_allowance_spend_kind_v2') THEN
  ALTER TABLE paypal_allowance_spend DROP CONSTRAINT IF EXISTS paypal_allowance_spend_kind_check;
  ALTER TABLE paypal_allowance_spend ADD CONSTRAINT paypal_allowance_spend_kind_v2 CHECK (kind IN ('reserve','release','refund'));
 END IF;
END $$;

-- Every index on paypal_tasks sits at the end on purpose. CREATE INDEX IF NOT
-- EXISTS still takes a share lock on the table for the rest of this
-- transaction, and live transactions write the ledger, spend and dispute
-- tables before they touch paypal_tasks, so the schema pass must lock in the
-- same order or the two can deadlock.
CREATE INDEX IF NOT EXISTS paypal_tasks_workspace_created ON paypal_tasks(workspace, created_at DESC, id);
CREATE INDEX IF NOT EXISTS paypal_tasks_share_token ON paypal_tasks((record->>'share_token'));
CREATE INDEX IF NOT EXISTS paypal_tasks_order_id ON paypal_tasks((record->>'order_id'));
CREATE INDEX IF NOT EXISTS paypal_tasks_capture_id ON paypal_tasks((record->>'capture_id'));
CREATE INDEX IF NOT EXISTS paypal_tasks_refund_id ON paypal_tasks((record->>'refund_id'));
CREATE INDEX IF NOT EXISTS paypal_tasks_purchase_buyer ON paypal_tasks((record->'purchase'->>'buyer'));
CREATE INDEX IF NOT EXISTS paypal_tasks_purchase_approval ON paypal_tasks((record->'purchase'->>'approval'));
