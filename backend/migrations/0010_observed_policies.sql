-- Mandate policy limits read by the relay after a receipt finalized, for
-- receipts that carry no on-chain policy snapshot. This is relay evidence,
-- not Solana evidence, and is always labeled relay-observed.
-- limits holds u64 values as decimal strings. Rows are written once: the
-- first observation is the one closest to the payment.
CREATE TABLE IF NOT EXISTS observed_policies (
    cluster TEXT NOT NULL,
    program_id TEXT NOT NULL,
    receipt_address TEXT NOT NULL,
    mandate TEXT NOT NULL,
    limits JSONB NOT NULL,
    observed_at_slot BIGINT NOT NULL,
    includes_later_payments BOOLEAN NOT NULL,
    observed_at_ms BIGINT NOT NULL,
    PRIMARY KEY (cluster, program_id, receipt_address),
    CONSTRAINT observed_policies_cluster_check CHECK (cluster = 'devnet')
);
