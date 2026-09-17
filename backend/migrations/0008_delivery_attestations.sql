-- Immutable seller response-served statements. Publication time is the
-- relay insert clock; served_at is the seller-signed timestamp. Rows are
-- never updated. Exact retries reuse the original statement.
CREATE TABLE IF NOT EXISTS delivery_attestations (
    cluster TEXT NOT NULL,
    program_id TEXT NOT NULL,
    receipt_address TEXT NOT NULL,
    seller TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    served_at TEXT NOT NULL,
    signature TEXT NOT NULL,
    canonical_payload TEXT NOT NULL,
    published_at_ms BIGINT NOT NULL,
    PRIMARY KEY (cluster, program_id, receipt_address, seller),
    CONSTRAINT delivery_attestations_cluster_check CHECK (cluster = 'devnet'),
    CONSTRAINT delivery_attestations_content_hash_check
        CHECK (content_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS delivery_attestations_receipt_idx
    ON delivery_attestations (cluster, program_id, receipt_address);
