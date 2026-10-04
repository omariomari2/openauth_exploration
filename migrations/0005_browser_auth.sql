-- Browser-bound, one-use PKCE transactions; times are Unix milliseconds.
CREATE TABLE login_transactions (
    state_hash TEXT PRIMARY KEY NOT NULL CHECK (length(state_hash) = 64),
    browser_hash TEXT NOT NULL CHECK (length(browser_hash) = 64),
    verifier TEXT NOT NULL CHECK (length(verifier) BETWEEN 43 AND 128),
    expires_at INTEGER NOT NULL CHECK (expires_at >= 0)
);

CREATE INDEX idx_login_transactions_expiry ON login_transactions(expires_at);

-- CSRF tokens do not authenticate requests; only the opaque session secret does.
CREATE TABLE browser_sessions (
    token_hash TEXT PRIMARY KEY NOT NULL CHECK (length(token_hash) = 64),
    user_id TEXT NOT NULL,
    csrf_token TEXT NOT NULL CHECK (length(csrf_token) = 43),
    expires_at INTEGER NOT NULL CHECK (expires_at >= 0),
    FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE
);

CREATE INDEX idx_browser_sessions_user_id ON browser_sessions(user_id);
CREATE INDEX idx_browser_sessions_expiry ON browser_sessions(expires_at);
