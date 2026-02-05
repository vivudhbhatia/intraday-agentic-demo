from __future__ import annotations
from fastapi import FastAPI
from datetime import datetime, timedelta
from fastapi.middleware.cors import CORSMiddleware
from typing import Dict, Any, List
import httpx

from shared.app_common.db import fetch_all, fetch_one, exec_sql
from shared.app_common.utils import uid, now_utc
from shared.app_common.models import RecommendationRequest, RecommendationResponse

app = FastAPI(title="decision-engine-service")



app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],   # demo only
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


RISK_ENGINE_URL = "http://risk-engine-service:8080"  # for local docker compose; override on Cloud Run
FORECAST_HORIZON_MIN = 180

def _cutoff_ok(action_type: str, as_of: datetime) -> tuple[bool, str]:
    row = fetch_one("SELECT cutoff_time_local FROM cutoffs WHERE action_type=%(a)s", {"a": action_type})
    if not row:
        return True, "no cutoff configured"
    hh, mm = row["cutoff_time_local"].split(":")
    cutoff_today = as_of.replace(hour=int(hh), minute=int(mm), second=0, microsecond=0)
    if as_of <= cutoff_today:
        return True, "before cutoff"
    return False, f"after cutoff {row['cutoff_time_local']}"

async def _risk_state(scenario_id: str, entity_id: str, currency: str) -> Dict[str, Any]:
    async with httpx.AsyncClient(timeout=20.0) as client:
        r = await client.get(f"{RISK_ENGINE_URL}/risk_state", params={"scenario_id": scenario_id, "entity_id": entity_id, "currency": currency})
        r.raise_for_status()
        return r.json()

def _simulate_sweep(risk: Dict[str, Any], latency_min: int, amount: float) -> Dict[str, Any]:
    # Inject amount after latency into forecast curve (simple deterministic what-if)
    as_of = datetime.fromisoformat(risk["as_of"])
    forecast = risk["forecast"]
    new_series = []
    injected = False
    inject_time = as_of + timedelta(minutes=latency_min)
    for pt in forecast:
        t = datetime.fromisoformat(pt["t"])
        bal = float(pt["balance"])
        if not injected and t >= inject_time:
            bal += amount
            injected = True
        new_series.append({"t": pt["t"], "balance": bal})
    return {"forecast": new_series}

def _simulate_throttle(risk: Dict[str, Any], delay_min: int, throttle_amt: float) -> Dict[str, Any]:
    # Approximation: increase balances by delaying outflows in aggregate
    # (Shifts some outflows beyond horizon).
    # For v1: apply a constant uplift before delay point.
    as_of = datetime.fromisoformat(risk["as_of"])
    new_series = []
    delay_time = as_of + timedelta(minutes=delay_min)
    for pt in risk["forecast"]:
        t = datetime.fromisoformat(pt["t"])
        bal = float(pt["balance"])
        if t < delay_time:
            bal += throttle_amt
        new_series.append({"t": pt["t"], "balance": bal})
    return {"forecast": new_series}

def _minutes_to_breach_from_series(series: List[Dict[str, Any]], threshold: float, as_of: datetime) -> int | None:
    for pt in series:
        t = datetime.fromisoformat(pt["t"])
        if float(pt["balance"]) < threshold:
            return max(0, int((t - as_of).total_seconds() // 60))
    return None

def _rank(actions: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    # Sort by:
    # 1) avoids breach (minutes_to_breach becomes None)
    # 2) largest minutes_to_breach improvement
    # 3) lowest cost
    def key(a):
        avoids = 1 if a["new_minutes_to_breach"] is None else 0
        return (-avoids, -(a["improvement_minutes"] or 0), a["estimated_cost"])
    return sorted(actions, key=key)

@app.get("/health")
def health():
    return {"ok": True}

@app.post("/recommendations", response_model=RecommendationResponse)
async def recommendations(req: RecommendationRequest):
    risk = await _risk_state(req.scenario_id, req.entity_id, req.currency)
    as_of = datetime.fromisoformat(risk["as_of"])
    threshold = float(risk["early_warning_buffer"])
    baseline_mtb = risk["minutes_to_breach"]

    candidates: List[Dict[str, Any]] = []

    # Candidate 1: Sweep (if inventory exists)
    sweeps = fetch_all("""
      SELECT sweep_id, max_amount, latency_minutes, cost_bps
      FROM action_inventory_sweeps
      WHERE currency=%(c)s
      ORDER BY max_amount DESC
    """, {"c": req.currency})
    if sweeps:
        ok, reason = _cutoff_ok("SWEEP", as_of)
        if ok:
            s = sweeps[0]
            # Choose amount: enough to cover projected shortfall + buffer, capped by max
            # Simple heuristic: if baseline breach within horizon, add 1.2x buffer gap
            buffer_remaining = float(risk["buffer_remaining"])
            needed = max(0.0, -buffer_remaining) + 0.25 * threshold
            amt = float(min(float(s["max_amount"]), max(0.0, needed)))
            if amt > 0:
                sim = _simulate_sweep(risk, int(s["latency_minutes"]), amt)
                new_mtb = _minutes_to_breach_from_series(sim["forecast"], threshold, as_of)
                improvement = (baseline_mtb - new_mtb) if (baseline_mtb is not None and new_mtb is not None) else None
                if baseline_mtb is not None and new_mtb is None:
                    improvement = baseline_mtb
                est_cost = amt * float(s["cost_bps"]) / 10000.0
                candidates.append({
                    "action_type": "SWEEP",
                    "action_id": s["sweep_id"],
                    "parameters": {"amount": amt, "latency_minutes": int(s["latency_minutes"])},
                    "constraint_pass": True,
                    "constraint_reason": "PASS",
                    "new_minutes_to_breach": new_mtb,
                    "improvement_minutes": improvement,
                    "estimated_cost": float(est_cost),
                    "impact_summary": f"+{amt:,.0f} {req.currency} after {int(s['latency_minutes'])} min"
                })
        else:
            candidates.append({
                "action_type": "SWEEP",
                "action_id": sweeps[0]["sweep_id"],
                "parameters": {},
                "constraint_pass": False,
                "constraint_reason": reason,
                "new_minutes_to_breach": baseline_mtb,
                "improvement_minutes": 0,
                "estimated_cost": 0.0,
                "impact_summary": "Blocked by cutoff"
            })

    # Candidate 2: Throttle (delay normal queued outflows)
    ok, reason = _cutoff_ok("THROTTLE", as_of)
    if ok:
        # Choose throttle amount based on near-term outflows drivers (approx)
        # Use top drivers: sum of NORMAL OUT amounts in next 120 mins * 25%
        throttle_base = 0.0
        for d in risk.get("drivers", []):
            if d["direction"] == "OUT" and d["priority"] == "NORMAL":
                throttle_base += float(d["amount"])
        throttle_amt = 0.25 * throttle_base
        if throttle_amt > 0:
            sim = _simulate_throttle(risk, delay_min=45, throttle_amt=throttle_amt)
            new_mtb = _minutes_to_breach_from_series(sim["forecast"], threshold, as_of)
            improvement = (baseline_mtb - new_mtb) if (baseline_mtb is not None and new_mtb is not None) else None
            if baseline_mtb is not None and new_mtb is None:
                improvement = baseline_mtb
            candidates.append({
                "action_type": "THROTTLE",
                "action_id": "THR_1",
                "parameters": {"delay_minutes": 45, "throttle_amount": throttle_amt},
                "constraint_pass": True,
                "constraint_reason": "PASS",
                "new_minutes_to_breach": new_mtb,
                "improvement_minutes": improvement,
                "estimated_cost": float(throttle_amt * 0.00005),  # token cost placeholder
                "impact_summary": f"Delay NORMAL outflows ~{throttle_amt:,.0f} {req.currency} for 45 min"
            })
    else:
        candidates.append({
            "action_type": "THROTTLE",
            "action_id": "THR_1",
            "parameters": {},
            "constraint_pass": False,
            "constraint_reason": reason,
            "new_minutes_to_breach": baseline_mtb,
            "improvement_minutes": 0,
            "estimated_cost": 0.0,
            "impact_summary": "Blocked by cutoff"
        })

    ranked = _rank([c for c in candidates if c["constraint_pass"]]) + [c for c in candidates if not c["constraint_pass"]]

    explanation = (
        f"Early-warning buffer is treated as minimum buffer for breach. "
        f"Baseline minutes-to-breach: {baseline_mtb}. "
        f"Ranked actions prioritize breach avoidance, then time gained, then lower cost."
    )

    rec_id = uid("REC")
    exec_sql("""
      INSERT INTO decision_recommendations(rec_id, scenario_id, ts, entity_id, currency, as_of, risk_state, ranked_actions, explanation)
      VALUES (%(rec_id)s, %(scenario_id)s, %(ts)s, %(entity_id)s, %(currency)s, %(as_of)s, %(risk_state)s::jsonb, %(ranked)s::jsonb, %(explanation)s)
    """, {
        "rec_id": rec_id,
        "scenario_id": req.scenario_id,
        "ts": now_utc(),
        "entity_id": req.entity_id,
        "currency": req.currency,
        "as_of": as_of,
        "risk_state": str(risk).replace("'", '"'),
        "ranked": str(ranked).replace("'", '"'),
        "explanation": explanation
    })

    return RecommendationResponse(
        rec_id=rec_id,
        scenario_id=req.scenario_id,
        as_of=as_of,
        entity_id=req.entity_id,
        currency=req.currency,
        ranked_actions=ranked,
        explanation=explanation
    )
