from __future__ import annotations
from fastapi import FastAPI, Query
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Any
import numpy as np

from shared.app_common.db import fetch_one, fetch_all
from shared.app_common.models import RiskStateResponse

app = FastAPI(title="risk-engine-service")

FORECAST_MINUTES = 180
STEP_MINUTES = 5

def _get_as_of(scenario_id: str) -> datetime:
    row = fetch_one("SELECT as_of FROM scenario_state WHERE scenario_id=%(s)s", {"s": scenario_id})
    if not row:
        raise ValueError("scenario not started")
    return row["as_of"]

def _opening_balance(scenario_id: str, entity_id: str, currency: str) -> float:
    row = fetch_one("""
      SELECT COALESCE(SUM(opening_balance),0) AS ob
      FROM opening_balances
      WHERE scenario_id=%(s)s AND entity_id=%(e)s AND currency=%(c)s
    """, {"s": scenario_id, "e": entity_id, "c": currency})
    return float(row["ob"] or 0)

def _settled_net(scenario_id: str, entity_id: str, currency: str, as_of: datetime) -> float:
    rows = fetch_one("""
      SELECT
        COALESCE(SUM(CASE WHEN direction='IN'  THEN amount ELSE 0 END),0) AS inflow,
        COALESCE(SUM(CASE WHEN direction='OUT' THEN amount ELSE 0 END),0) AS outflow
      FROM cash_events
      WHERE scenario_id=%(s)s AND entity_id=%(e)s AND currency=%(c)s
        AND status='SETTLED'
        AND ts_actual_settle <= %(as_of)s
    """, {"s": scenario_id, "e": entity_id, "c": currency, "as_of": as_of})
    return float(rows["inflow"] - rows["outflow"])

def _mark_settled(scenario_id: str, as_of: datetime):
    # Treat RELEASED events whose actual settle time has passed as SETTLED.
    # Keep FAILED as FAILED.
    # QUEUED remains QUEUED.
    # This is intentional simplification.
    # (We don't write here; simulator releases queued ones. We only update status for RELEASED.)
    from shared.app_common.db import exec_sql
    exec_sql("""
      UPDATE cash_events
      SET status='SETTLED'
      WHERE scenario_id=%(s)s
        AND status='RELEASED'
        AND ts_actual_settle IS NOT NULL
        AND ts_actual_settle <= %(as_of)s
    """, {"s": scenario_id, "as_of": as_of})

def _early_warning_buffer(entity_id: str, currency: str) -> float:
    row = fetch_one("""
      SELECT early_warning_buffer
      FROM early_warning_limits
      WHERE entity_id=%(e)s AND currency=%(c)s
    """, {"e": entity_id, "c": currency})
    return float(row["early_warning_buffer"])

def _future_events(scenario_id: str, entity_id: str, currency: str, as_of: datetime) -> List[Dict[str, Any]]:
    # Consider:
    # - RELEASED with settle times
    # - QUEUED (assume worst-case: settle at expected time, unless later throttled)
    # Ignore FAILED.
    return fetch_all("""
      SELECT event_id, direction, amount,
             COALESCE(ts_actual_settle, ts_expected_settle) AS ts_settle,
             status, priority, rail
      FROM cash_events
      WHERE scenario_id=%(s)s AND entity_id=%(e)s AND currency=%(c)s
        AND status IN ('RELEASED','QUEUED')
        AND COALESCE(ts_actual_settle, ts_expected_settle) > %(as_of)s
        AND COALESCE(ts_actual_settle, ts_expected_settle) <= %(horizon)s
      ORDER BY ts_settle ASC
    """, {
        "s": scenario_id, "e": entity_id, "c": currency,
        "as_of": as_of, "horizon": as_of + timedelta(minutes=FORECAST_MINUTES)
    })

def _forecast_curve(current_balance: float, events: List[Dict[str, Any]], as_of: datetime) -> List[Dict[str, Any]]:
    # Bucket events into STEP_MINUTES intervals and apply cumulatively.
    buckets = {}
    for ev in events:
        t = ev["ts_settle"]
        # bucket to nearest lower step
        delta = int((t - as_of).total_seconds() // 60)
        b = (delta // STEP_MINUTES) * STEP_MINUTES
        buckets.setdefault(b, 0.0)
        amt = float(ev["amount"])
        buckets[b] += amt if ev["direction"] == "IN" else -amt

    series = []
    bal = float(current_balance)
    series.append({"t": as_of.isoformat(), "balance": bal})
    for m in range(STEP_MINUTES, FORECAST_MINUTES + STEP_MINUTES, STEP_MINUTES):
        bal += buckets.get(m, 0.0)
        series.append({"t": (as_of + timedelta(minutes=m)).isoformat(), "balance": bal})
    return series

def _minutes_to_breach(series: List[Dict[str, Any]], threshold: float, as_of: datetime) -> int | None:
    # breach when balance < threshold
    for pt in series:
        t = datetime.fromisoformat(pt["t"])
        if float(pt["balance"]) < threshold:
            return max(0, int((t - as_of).total_seconds() // 60))
    return None

def _drivers(scenario_id: str, entity_id: str, currency: str, as_of: datetime) -> List[Dict[str, Any]]:
    # Drivers: largest net outflows in next 120 minutes
    rows = fetch_all("""
      SELECT event_id,
             COALESCE(ts_actual_settle, ts_expected_settle) AS ts,
             direction, amount, status, priority, rail
      FROM cash_events
      WHERE scenario_id=%(s)s AND entity_id=%(e)s AND currency=%(c)s
        AND status IN ('RELEASED','QUEUED')
        AND COALESCE(ts_actual_settle, ts_expected_settle) > %(as_of)s
        AND COALESCE(ts_actual_settle, ts_expected_settle) <= %(until)s
      ORDER BY amount DESC
      LIMIT 8
    """, {"s": scenario_id, "e": entity_id, "c": currency, "as_of": as_of, "until": as_of + timedelta(minutes=120)})
    return [{"event_id": r["event_id"], "ts": r["ts"].isoformat(), "direction": r["direction"],
             "amount": float(r["amount"]), "status": r["status"], "priority": r["priority"], "rail": r["rail"]} for r in rows]

@app.get("/health")
def health():
    return {"ok": True}

@app.get("/risk_state", response_model=RiskStateResponse)
def risk_state(
    scenario_id: str = Query(...),
    entity_id: str = Query("E1"),
    currency: str = Query(..., description="USD/EUR/GBP")
):
    as_of = _get_as_of(scenario_id)
    _mark_settled(scenario_id, as_of)

    ob = _opening_balance(scenario_id, entity_id, currency)
    net = _settled_net(scenario_id, entity_id, currency, as_of)
    current_balance = ob + net

    ew = _early_warning_buffer(entity_id, currency)
    buffer_remaining = current_balance - ew

    fut = _future_events(scenario_id, entity_id, currency, as_of)
    series = _forecast_curve(current_balance, fut, as_of)
    mtb = _minutes_to_breach(series, ew, as_of)

    return RiskStateResponse(
        scenario_id=scenario_id,
        as_of=as_of,
        entity_id=entity_id,
        currency=currency,
        current_balance=float(current_balance),
        early_warning_buffer=float(ew),
        buffer_remaining=float(buffer_remaining),
        minutes_to_breach=mtb,
        forecast=series,
        drivers=_drivers(scenario_id, entity_id, currency, as_of)
    )
