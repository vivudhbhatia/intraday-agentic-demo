INSERT INTO entities(entity_id, entity_name)
VALUES ('E1', 'Entity 1')
ON CONFLICT DO NOTHING;

-- Multi-currency accounts: USD + EUR + GBP (expand later)
INSERT INTO accounts(account_id, entity_id, currency, account_type, sweep_enabled)
VALUES
  ('A_USD_OPS', 'E1', 'USD', 'OPERATING', TRUE),
  ('A_USD_FND', 'E1', 'USD', 'FUNDING', TRUE),
  ('A_EUR_OPS', 'E1', 'EUR', 'OPERATING', TRUE),
  ('A_EUR_FND', 'E1', 'EUR', 'FUNDING', TRUE),
  ('A_GBP_OPS', 'E1', 'GBP', 'OPERATING', TRUE),
  ('A_GBP_FND', 'E1', 'GBP', 'FUNDING', TRUE)
ON CONFLICT DO NOTHING;

-- Early warning threshold acts as "minimum buffer" for breach logic
INSERT INTO early_warning_limits(entity_id, currency, early_warning_buffer)
VALUES
  ('E1','USD',  50000000),
  ('E1','EUR',  30000000),
  ('E1','GBP',  20000000)
ON CONFLICT DO NOTHING;

INSERT INTO cutoffs(action_type, cutoff_time_local, timezone)
VALUES
  ('SWEEP', '16:30', 'America/New_York'),
  ('THROTTLE', '16:45', 'America/New_York')
ON CONFLICT DO NOTHING;

-- Sweep inventory (within-currency only)
INSERT INTO action_inventory_sweeps(sweep_id, from_account_id, to_account_id, currency, max_amount, latency_minutes, cost_bps)
VALUES
  ('SWP_USD_1', 'A_USD_FND', 'A_USD_OPS', 'USD', 200000000, 10, 1),
  ('SWP_EUR_1', 'A_EUR_FND', 'A_EUR_OPS', 'EUR', 120000000, 10, 1),
  ('SWP_GBP_1', 'A_GBP_FND', 'A_GBP_OPS', 'GBP',  80000000, 10, 1)
ON CONFLICT DO NOTHING;
