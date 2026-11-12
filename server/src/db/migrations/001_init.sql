-- Inkwell schema.  Embeddings are 1024-dimensional (Voyage default); changing
-- the dimension requires a new migration and a full re-index.

CREATE EXTENSION IF NOT EXISTS vector;

-- ---------------------------------------------------------------- users ----
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  name          text NOT NULL,
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_key ON users (lower(email));

-- Refresh tokens are opaque random strings; only their SHA-256 hash is stored.
-- Every login starts a "family"; rotating a token keeps the family, and
-- presenting an already-rotated token revokes the whole family (theft signal).
CREATE TABLE refresh_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  family_id  uuid NOT NULL,
  token_hash text NOT NULL UNIQUE,
  user_agent text,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id);
CREATE INDEX refresh_tokens_family_idx ON refresh_tokens (family_id);

-- -------------------------------------------------------------- entries ----
CREATE TABLE entries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  title            text NOT NULL DEFAULT '',
  content          text NOT NULL,
  mood             smallint CHECK (mood BETWEEN 1 AND 5),
  tags             text[] NOT NULL DEFAULT '{}',
  entry_date       date NOT NULL,
  word_count       integer NOT NULL DEFAULT 0,
  -- Hash of everything that feeds the embedding; lets the indexer detect that
  -- an entry changed while it was being embedded.
  content_hash     text NOT NULL,
  embedding_status text NOT NULL DEFAULT 'pending'
                   CHECK (embedding_status IN ('pending', 'ready', 'failed')),
  embedding_error  text,
  indexed_at       timestamptz,
  search           tsvector GENERATED ALWAYS AS (
                     setweight(to_tsvector('english', title), 'A') ||
                     setweight(to_tsvector('english', content), 'B')
                   ) STORED,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX entries_user_date_idx ON entries (user_id, entry_date DESC, id DESC);
CREATE INDEX entries_search_idx ON entries USING gin (search);
CREATE INDEX entries_tags_idx ON entries USING gin (tags);
CREATE INDEX entries_pending_idx ON entries (embedding_status) WHERE embedding_status <> 'ready';

-- An entry is split into overlapping chunks; each chunk gets one embedding.
CREATE TABLE entry_chunks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id        uuid NOT NULL REFERENCES entries (id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  chunk_index     integer NOT NULL,
  content         text NOT NULL,
  embedding       vector(1024) NOT NULL,
  -- "<provider>:<model>".  Vectors from different models live in different
  -- spaces, so searches only compare chunks embedded by the active model.
  embedding_model text NOT NULL,
  search          tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entry_id, chunk_index)
);
CREATE INDEX entry_chunks_user_idx ON entry_chunks (user_id);
CREATE INDEX entry_chunks_search_idx ON entry_chunks USING gin (search);
CREATE INDEX entry_chunks_embedding_idx ON entry_chunks USING hnsw (embedding vector_cosine_ops);

-- Image attachments.  The bytes live in S3; this table holds the object key.
CREATE TABLE attachments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  entry_id     uuid NOT NULL REFERENCES entries (id) ON DELETE CASCADE,
  storage_key  text NOT NULL UNIQUE,
  file_name    text NOT NULL,
  content_type text NOT NULL,
  size_bytes   integer NOT NULL,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready')),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX attachments_entry_idx ON attachments (entry_id);

-- ----------------------------------------------------------------- chat ----
CREATE TABLE conversations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  title      text NOT NULL DEFAULT 'New conversation',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conversations_user_idx ON conversations (user_id, updated_at DESC);

CREATE TABLE messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('user', 'assistant')),
  content         text NOT NULL,
  -- What retrieval handed to the model for this answer: {entries, memories, range}.
  sources         jsonb,
  -- Model id, token usage, stop reason, timings.
  meta            jsonb,
  seq             bigserial,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_conversation_idx ON messages (conversation_id, seq);

-- ------------------------------------------------------- long-term memory ---
-- Durable facts about the user, distilled from chats and journal entries.
CREATE TABLE memories (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  content                text NOT NULL,
  category               text NOT NULL DEFAULT 'other',
  importance             smallint NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
  embedding              vector(1024) NOT NULL,
  embedding_model        text NOT NULL,
  source_type            text NOT NULL DEFAULT 'manual' CHECK (source_type IN ('chat', 'entry', 'manual')),
  source_conversation_id uuid REFERENCES conversations (id) ON DELETE SET NULL,
  source_entry_id        uuid REFERENCES entries (id) ON DELETE SET NULL,
  access_count           integer NOT NULL DEFAULT 0,
  last_accessed_at       timestamptz,
  archived_at            timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX memories_user_idx ON memories (user_id) WHERE archived_at IS NULL;
CREATE INDEX memories_embedding_idx ON memories USING hnsw (embedding vector_cosine_ops);
