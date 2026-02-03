-- Core reference data
CREATE TABLE IF NOT EXISTS entities (
  entity_id TEXT PRIMARY KEY,
  entity_name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  account_id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL REFERENCES entities(entity_id),
  currency TEXT NOT NULL,
  account_type TEXT NOT NULL, -- OPERATING / FUNDING / NOSTRO
  sweep_enabled BOOLEAN NOT NULL DEFAULT TRUE
);

-- Early warning threshold is the "minimum buffer" for v1 breach logic.
CREATE TABLE IF NOT EXISTS early_warning_limits (
  entity_id TEXT NOT NULL REFERENCES entities(entity_id),
  currency TEXT NOT NULL,
  early_warning_buffer NUMERIC NOT NULL,
  PRIMARY KEY (entity_id, currency)
);

CREATE TABLE IF NOT EXISTS cutoffs (
  action_type TEXT PRIMARY KEY, -- SWEEP / THROTTLE
  cutoff_time_local TEXT NOT NULL, -- "HH:MM"
  timezone TEXT NOT NULL DEFAULT 'America/New_York'
);

-- Intraday events
CREATE TABLE IF NOT EXISTS cash_events (
  event_id TEXT PRIMARY KEY,
  scenario_id TEXT NOT NULL,
  ts_created TIMESTAMPTZ NOT NULL,
  ts_expected_settle TIMESTAMPTZ NOT NULL,
  ts_actual_settle TIMESTAMPTZ,
  entity_id TEXT NOT NULL REFERENCES entities(entity_id),
  currency TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(account_id),
  direction TEXT NOT NULL, -- IN / OUT
  amount NUMERIC NOT NULL,
  event_type TEXT NOT NULL, -- PAYMENT / SETTLEMENT / FUNDING
  rail TEXT NOT NULL, -- WIRE / ACH / INTERNAL
  status TEXT NOT NULL, -- QUEUED / RELEASED / SETTLED / FAILED
  priority TEXT NOT NULL DEFAULT 'NORMAL' -- CRITICAL / NORMAL
);

-- "Now" pointer per scenario for replay mode
CREATE TABLE IF NOT EXISTS scenario_state (
  scenario_id TEXT PRIMARY KEY,
  as_of TIMESTAMPTZ NOT NULL,
  tz TEXT NOT NULL DEFAULT 'America/New_York'
);

-- Opening balances per scenario
CREATE TABLE IF NOT EXISTS opening_balances (
  scenario_id TEXT NOT NULL,
  ts_open TIMESTAMPTZ NOT NULL,
  entity_id TEXT NOT NULL REFERENCES entities(entity_id),
  currency TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(account_id),
  opening_balance NUMERIC NOT NULL,
  PRIMARY KEY (scenario_id, entity_id, currency, account_id)
);

-- Action inventory: sweeps
CREATE TABLE IF NOT EXISTS action_inventory_sweeps (
  sweep_id TEXT PRIMARY KEY,
  from_account_id TEXT NOT NULL REFERENCES accounts(account_id),
  to_account_id TEXT NOT NULL REFERENCES accounts(account_id),
  currency TEXT NOT NULL,
  max_amount NUMERIC NOT NULL,
  latency_minutes INT NOT NULL,
  cost_bps NUMERIC NOT NULL DEFAULT 0
);

-- Recommendations / approvals / audit
CREATE TABLE IF NOT EXISTS decision_recommendations (
  rec_id TEXT PRIMARY KEY,
  scenario_id TEXT NOT NULL,
  ts TIMESTAMPTZ NOT NULL,
  entity_id TEXT NOT NULL REFERENCES entities(entity_id),
  currency TEXT NOT NULL,
  as_of TIMESTAMPTZ NOT NULL,
  risk_state JSONB NOT NULL,
  ranked_actions JSONB NOT NULL,
  explanation TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING_APPROVAL' -- PENDING_APPROVAL / APPROVED / REJECTED / EXPIRED
);

CREATE TABLE IF NOT EXISTS approvals (
  approval_id TEXT PRIMARY KEY,
  rec_id TEXT NOT NULL REFERENCES decision_recommendations(rec_id),
  ts TIMESTAMPTZ NOT NULL,
  decision TEXT NOT NULL, -- APPROVE / REJECT
  approver_role TEXT NOT NULL DEFAULT 'LIQUIDITY_RISK_HEAD',
  comment TEXT
);

CREATE TABLE IF NOT EXISTS execution_events (
  exec_id TEXT PRIMARY KEY,
  rec_id TEXT NOT NULL REFERENCES decision_recommendations(rec_id),
  ts TIMESTAMPTZ NOT NULL,
  action_type TEXT NOT NULL,
  parameters JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'SIMULATED_EXECUTED'
);

CREATE TABLE IF NOT EXISTS audit_log (
  audit_id TEXT PRIMARY KEY,
  scenario_id TEXT NOT NULL,
  ts TIMESTAMPTZ NOT NULL,
  service TEXT NOT NULL,
  action TEXT NOT NULL,
  details JSONB NOT NULL
);

-- Helpful indexes
CREATE INDEX IF NOT EXISTS idx_cash_events_scenario_time ON cash_events(scenario_id, COALESCE(ts_actual_settle, ts_expected_settle));
CREATE INDEX IF NOT EXISTS idx_cash_events_lookup ON cash_events(scenario_id, entity_id, currency, account_id);
