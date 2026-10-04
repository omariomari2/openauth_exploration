-- Dedicated demo issuer keys: one immutable winner per purpose, never KV key material.
CREATE TABLE issuer_keys (
    purpose TEXT PRIMARY KEY NOT NULL CHECK (purpose IN ('encryption:key', 'signing:key')),
    key_id TEXT NOT NULL,
    value TEXT NOT NULL
);
