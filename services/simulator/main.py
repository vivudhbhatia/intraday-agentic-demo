from __future__ import annotations
from fastapi import FastAPI
from datetime import datetime, timedelta, timezone
import numpy as np

from shared.app_common.db import exec_sql, fetch_all, fetch_one
from shared.app_common.utils import uid, now_utc
from shared.app_common.models import ScenarioStartRequest, ScenarioStepRequest

app = FastAPI(title="simulator-service")

def _ensure_scenario_state(scenario_id: str, as_of: datetime):
    exec_sql("""
      INSERT INTO scenario_state(scenario_id, as_of)
      VALUES (%(scenario_id)s, %(as_of)s)
      ON CONFLICT (scenario_id) DO UPDATE SET as_of = EXCLUDED.as_of
    """, {"scenario_id": scenario_id, "as_of": as_of})

def _clear_scenario(scenario_id: str):
    exec_sql("DELETE FROM cash_events WHERE scenario_id=%(s)s", {"s": scenario_id})
    exec_sql("DELETE FROM opening_balances WHERE scenario_id=%(s)s", {"s": scenario_id})
    exec_sql("DELETE FROM decision_recommendations WHERE scenario_id=%(s)s", {"s": scenario_id})
    exec_sql("DELETE FROM approvals WHERE rec_id IN (SELECT rec_id FROM decision_recommendations WHERE scenario_id=%(s)s)", {"s": scenario_id})
    exec_sql("DELETE FROM execution_events WHERE rec_id IN (SELECT rec_id FROM decision_recommendations WHERE scenario_id=%(s)s)", {"s": scenario_id})
    exec_sql("DELETE FROM audit_log WHERE scenario_id=%(s)s", {"s": scenario_id})

def _seed_opening_balances(scenario_id: str, ts_open: datetime, rng: np.random.Generator):
    accounts = fetch_all("SELECT account_id, entity_id, currency FROM accounts ORDER BY account_id")
    for a in accounts:
        # Funding accounts start higher; operating lower; adjust as needed
        if a["account_id"].endswith("_FND"):
            base = {"USD": 400e6, "EUR": 250e6, "GBP": 180e6}.get(a["currency"], 200e6)
        else:
            base = {"USD": 120e6, "EUR":  80e6, "GBP":  60e6}.get(a["currency"],  60e6)
        opening = float(base * rng.uniform(0.85, 1.15))
        exec_sql("""
          INSERT INTO opening_balances(scenario_id, ts_open, entity_id, currency, account_id, opening_balance)
          VALUES (%(scenario_id)s, %(ts_open)s, %(entity_id)s, %(currency)s, %(account_id)s, %(opening)s)
        """, {**a, "scenario_id": scenario_id, "ts_open": ts_open, "opening": opening})

def _intraday_intensity(hour: int) -> float:
    # Simple seasonality: morning wave + afternoon wave
    if 9 <= hour <= 11:
        return 1.6
    if 14 <= hour <= 16:
        return 1.8
    if 7 <= hour <= 8:
        return 1.2
    return 0.8

def _generate_events_for_currency(scenario_id: str, entity_id: str, currency: str, ts_open: datetime, rng: np.random.Generator, scenario_mode: str):
    # Create ~300-800 events/day total across currencies; scale by currency
    scale = {"USD": 1.2, "EUR": 0.9, "GBP": 0.7}.get(currency, 0.8)
    n_events = int(rng.integers(180, 340) * scale)

    ops_account = fetch_one("""
      SELECT account_id FROM accounts WHERE entity_id=%(e)s AND currency=%(c)s AND account_type='OPERATING'
    """, {"e": entity_id, "c": currency})["account_id"]

    # Generate times across the day
    times = []
    for _ in range(n_events):
        h = int(rng.integers(7, 18))
        intensity = _intraday_intensity(h)
        minute = int(rng.integers(0, 60))
        # Cluster toward settlement windows by shrinking jitter when intensity high
        jitter = int(rng.normal(0, 8 / intensity))
        t = ts_open.replace(hour=h, minute=minute, second=0, microsecond=0) + timedelta(minutes=jitter)
        # clamp to same day range
        if t < ts_open.replace(hour=7, minute=0, second=0, microsecond=0):
            t = ts_open.replace(hour=7, minute=0, second=0, microsecond=0)
        if t > ts_open.replace(hour=18, minute=0, second=0, microsecond=0):
            t = ts_open.replace(hour=18, minute=0, second=0, microsecond=0)
        times.append(t)

    times.sort()
    # Amounts: heavy tail
    amounts = rng.lognormal(mean=np.log(2.5e6), sigma=1.0, size=len(times))
    amounts = np.clip(amounts, 25000, 75e6)  # cap extremes

    for t, amt in zip(times, amounts):
        direction = "IN" if rng.random() < 0.50 else "OUT"
        rail = "WIRE" if rng.random() < 0.35 else ("ACH" if rng.random() < 0.6 else "INTERNAL")
        priority = "CRITICAL" if rng.random() < 0.08 else "NORMAL"
        status = "QUEUED" if (direction == "OUT" and rng.random() < 0.25) else "RELEASED"

        expected = t + timedelta(minutes=int(rng.integers(5, 40)))
        actual = expected

        # Scenario perturbations
        if scenario_mode == "DELAYED_INFLOWS" and direction == "IN" and rng.random() < 0.18:
            actual = expected + timedelta(minutes=int(rng.integers(60, 140)))
        if scenario_mode == "UNEXPECTED_OUTFLOW" and direction == "OUT" and rng.random() < 0.02:
            amt = amt * rng.uniform(8, 15)
        if scenario_mode == "QUEUE_BUILDUP" and direction == "OUT" and rng.random() < 0.45:
            status = "QUEUED"
            # queued items settle later once released
            actual = None
        if scenario_mode == "FAIL_INFLOW" and direction == "IN" and rng.random() < 0.02:
            status = "FAILED"
            actual = None

        # Convert to float
        amt = float(amt)

        event_id = uid("EVT")
        exec_sql("""
          INSERT INTO cash_events(
            event_id, scenario_id, ts_created, ts_expected_settle, ts_actual_settle,
            entity_id, currency, account_id, direction, amount,
            event_type, rail, status, priority
          )
          VALUES (
            %(event_id)s, %(scenario_id)s, %(ts_created)s, %(ts_expected)s, %(ts_actual)s,
            %(entity_id)s, %(currency)s, %(account_id)s, %(direction)s, %(amount)s,
            'PAYMENT', %(rail)s, %(status)s, %(priority)s
          )
        """, {
            "event_id": event_id,
            "scenario_id": scenario_id,
            "ts_created": t,
            "ts_expected": expected,
            "ts_actual": actual,
            "entity_id": entity_id,
            "currency": currency,
            "account_id": ops_account,
            "direction": direction,
            "amount": amt,
            "rail": rail,
            "status": status,
            "priority": priority
        })

def _release_queued_outflows(scenario_id: str, as_of: datetime):
    # For demo: when stepping time, release some queued outflows whose expected time has passed.
    exec_sql("""
      UPDATE cash_events
      SET status='RELEASED',
          ts_actual_settle = COALESCE(ts_actual_settle, ts_expected_settle)
      WHERE scenario_id=%(s)s
        AND direction='OUT'
        AND status='QUEUED'
        AND ts_expected_settle <= %(as_of)s
        AND priority='NORMAL'
    """, {"s": scenario_id, "as_of": as_of})

@app.get("/health")
def health():
    return {"ok": True}

@app.post("/scenario/start")
def start(req: ScenarioStartRequest):
    _clear_scenario(req.scenario_id)
    rng = np.random.default_rng(req.seed)

    ts_open = req.start_time_utc or now_utc().replace(hour=7, minute=0, second=0, microsecond=0)
    entity_id = "E1"

    _seed_opening_balances(req.scenario_id, ts_open, rng)

    # Pick scenario mode from scenario_id (simple mapping)
    sid = req.scenario_id.upper()
    if "DELAY" in sid:
        mode = "DELAYED_INFLOWS"
    elif "OUTFLOW" in sid:
        mode = "UNEXPECTED_OUTFLOW"
    elif "QUEUE" in sid:
        mode = "QUEUE_BUILDUP"
    elif "FAIL" in sid:
        mode = "FAIL_INFLOW"
    else:
        mode = "BASELINE"

    for ccy in ["USD","EUR","GBP"]:
        _generate_events_for_currency(req.scenario_id, entity_id, ccy, ts_open, rng, mode)

    _ensure_scenario_state(req.scenario_id, ts_open)

    return {"scenario_id": req.scenario_id, "as_of": ts_open, "mode": mode}

@app.post("/scenario/step")
def step(req: ScenarioStepRequest):
    row = fetch_one("SELECT as_of FROM scenario_state WHERE scenario_id=%(s)s", {"s": req.scenario_id})
    if not row:
        return {"error": "scenario not started"}
    as_of = row["as_of"] + timedelta(minutes=req.minutes)
    _ensure_scenario_state(req.scenario_id, as_of)
    _release_queued_outflows(req.scenario_id, as_of)
    return {"scenario_id": req.scenario_id, "as_of": as_of}

@app.post("/scenario/reset")
def reset(scenario_id: str):
    # resets "now" to opening time
    row = fetch_one("""
      SELECT ts_open FROM opening_balances
      WHERE scenario_id=%(s)s
      ORDER BY ts_open ASC
      LIMIT 1
    """, {"s": scenario_id})
    if not row:
        return {"error": "scenario not found"}
    _ensure_scenario_state(scenario_id, row["ts_open"])
    return {"scenario_id": scenario_id, "as_of": row["ts_open"]}
