-- Helpdesk schema (PostgreSQL)
CREATE TYPE user_role AS ENUM ('requester', 'agent', 'admin');
CREATE TYPE ticket_status AS ENUM ('open', 'in_progress', 'resolved', 'closed');

CREATE TABLE users (
  id               SERIAL PRIMARY KEY,
  name             TEXT NOT NULL,
  email            TEXT NOT NULL UNIQUE,
  password_hash    TEXT NOT NULL,
  role             user_role NOT NULL DEFAULT 'requester',
  last_assigned_at TIMESTAMPTZ,              -- drives round-robin assignment
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE categories (
  id   SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE priorities (
  name        TEXT PRIMARY KEY,
  rank        INT  NOT NULL UNIQUE,          -- 1 = most urgent
  sla_minutes INT  NOT NULL
);

CREATE TABLE tickets (
  id              SERIAL PRIMARY KEY,
  title           TEXT NOT NULL,
  description     TEXT NOT NULL,
  category_id     INT  NOT NULL REFERENCES categories(id),
  priority        TEXT NOT NULL REFERENCES priorities(name),
  status          ticket_status NOT NULL DEFAULT 'open',
  requester_id    INT  NOT NULL REFERENCES users(id),
  assignee_id     INT  REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  due_at          TIMESTAMPTZ NOT NULL,      -- SLA deadline
  resolved_at     TIMESTAMPTZ,
  breached_at     TIMESTAMPTZ,               -- set once when the SLA is missed
  escalated_count INT NOT NULL DEFAULT 0
);

CREATE TABLE comments (
  id         SERIAL PRIMARY KEY,
  ticket_id  INT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  author_id  INT REFERENCES users(id),       -- NULL for system notes
  body       TEXT NOT NULL,
  is_system  BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_tickets_queue     ON tickets (status, priority, due_at);
CREATE INDEX idx_tickets_assignee  ON tickets (assignee_id);
CREATE INDEX idx_tickets_requester ON tickets (requester_id);
CREATE INDEX idx_comments_ticket   ON comments (ticket_id, created_at);

INSERT INTO priorities (name, rank, sla_minutes) VALUES
  ('critical', 1, 60), ('high', 2, 240), ('medium', 3, 480), ('low', 4, 1440);
INSERT INTO categories (name) VALUES
  ('IT Issue'), ('HR Query'), ('Customer Complaint'), ('Access Request'), ('Facilities');
