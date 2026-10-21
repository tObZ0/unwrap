-- UNWRAP initial schema.
-- Users are anonymous: a browser holds a random owner token (httpOnly cookie);
-- only its SHA-256 hash is stored. No emails, IPs or wallet addresses of users are stored.

CREATE TABLE IF NOT EXISTS reports (
  id              TEXT PRIMARY KEY,                 -- 128-bit random, base64url (unguessable)
  network_id      TEXT NOT NULL,
  chain_id        INTEGER NOT NULL,
  address         TEXT NOT NULL,                    -- EIP-55 checksummed contract address
  contract_name   TEXT,
  classification  TEXT NOT NULL,
  depth           TEXT NOT NULL CHECK (depth IN ('source', 'abi', 'bytecode')),
  verified        BOOLEAN NOT NULL,
  visibility      TEXT NOT NULL CHECK (visibility IN ('public', 'private')),
  owner_hash      TEXT,
  max_severity    SMALLINT NOT NULL,                -- 0 critical .. 4 info, 5 = no findings
  finding_counts  JSONB NOT NULL,
  report          JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reports_lookup_idx ON reports (network_id, address, created_at DESC);
CREATE INDEX IF NOT EXISTS reports_public_recent_idx ON reports (created_at DESC) WHERE visibility = 'public';
CREATE INDEX IF NOT EXISTS reports_owner_idx ON reports (owner_hash, created_at DESC);

CREATE TABLE IF NOT EXISTS ai_messages (
  id          BIGSERIAL PRIMARY KEY,
  report_id   TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  owner_hash  TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content     JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_messages_conv_idx ON ai_messages (report_id, owner_hash, id);

CREATE TABLE IF NOT EXISTS rate_limits (
  key           TEXT PRIMARY KEY,                   -- route + salted hash of client IP
  window_start  TIMESTAMPTZ NOT NULL,
  count         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_events (
  id          BIGSERIAL PRIMARY KEY,
  kind        TEXT NOT NULL,                        -- 'analyze' | 'ask'
  network_id  TEXT,
  outcome     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS usage_events_time_idx ON usage_events (created_at DESC);
