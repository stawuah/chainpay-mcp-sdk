-- Merchant-signed payment requests, kept by receipt PDA once the relay has
-- checked that the request's canonical SHA-256 equals the payment's invoice
-- hash. Readable only by the mandate owner. canonical_payload is the exact
-- signed text: a JSON column could reorder keys and break the hash.
-- Rows are written once and never updated.
CREATE TABLE IF NOT EXISTS receipt_requests (
    cluster TEXT NOT NULL,
    program_id TEXT NOT NULL,
    receipt_address TEXT NOT NULL,
    mandate TEXT NOT NULL,
    invoice_hash TEXT NOT NULL,
    merchant TEXT NOT NULL,
    canonical_payload TEXT NOT NULL,
    signature TEXT NOT NULL,
    stored_at_ms BIGINT NOT NULL,
    PRIMARY KEY (cluster, program_id, receipt_address),
    CONSTRAINT receipt_requests_cluster_check CHECK (cluster = 'devnet'),
    CONSTRAINT receipt_requests_invoice_hash_check
        CHECK (invoice_hash ~ '^[0-9a-f]{64}$')
);
