-- Stable provider identity; email remains a signup snapshot on the user row.
-- Existing users are deliberately not linked or backfilled by email.
CREATE TABLE user_identities (
    provider TEXT NOT NULL CHECK (provider = 'google'),
    provider_subject TEXT NOT NULL CHECK (length(provider_subject) BETWEEN 1 AND 255),
    user_id TEXT NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (provider, provider_subject),
    FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE
);

CREATE INDEX idx_user_identities_user_id ON user_identities(user_id);
