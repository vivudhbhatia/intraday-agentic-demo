from __future__ import annotations
from fastapi import FastAPI
from datetime import datetime
import httpx

from shared.app_common.utils import uid, now_utc
from shared.app_common.db import exec_sql
from shared.app_common.models import RecommendationResponse

app = FastAPI(title="orchestrator-service")

SIM_URL = "http://simulator-service:8080"
RISK_URL = "http://risk-engine-service:8080"
DEC_URL  = "http://decision-engine-service:8080"

def _audit(scenario_id: str, service: str, action: str, details: dict):
    exec_sql("""
      INSERT INTO audit_log(audit_id, scenario_id, ts, service, action, details)
      VALUES (%(id)s, %(s)s, %(ts)s, %(svc)s, %(act)s, %(d)s::jsonb)
    """, {"id": uid("AUD"), "s": scenario_id, "ts": now_utc(), "svc": service, "act": action, "d": str(details).replace("'", '"')})

@app.get("/health")
def health():
    return {"ok": True}

@app.post("/run_cycle", response_model=RecommendationResponse)
async def run_cycle(scenario_id: str, entity_id: str = "E1", currency: str = "USD"):
    async with httpx.AsyncClient(timeout=30.0) as client:
        _audit(scenario_id, "orchestrator", "ASSESS_START", {"currency": currency})

        risk = (await client.get(f"{RISK_URL}/risk_state", params={"scenario_id": scenario_id, "entity_id": entity_id, "currency": currency})).json()
        _audit(scenario_id, "orchestrator", "RISK_STATE", {"minutes_to_breach": risk.get("minutes_to_breach"), "buffer_remaining": risk.get("buffer_remaining")})

        # Trigger recommendations only if within horizon risk exists (or buffer is low)
        mtb = risk.get("minutes_to_breach")
        if mtb is None and float(risk.get("buffer_remaining", 0)) > 0:
            # Still return a "no action needed" recommendation pack
            rec = {
                "rec_id": uid("REC"),
                "scenario_id": scenario_id,
                "as_of": risk["as_of"],
                "entity_id": entity_id,
                "currency": currency,
                "ranked_actions": [],
                "explanation": "No early-warning breach projected in forecast horizon. No action recommended."
            }
            _audit(scenario_id, "orchestrator", "NO_ACTION", rec)
            return rec

        rec = (await client.post(f"{DEC_URL}/recommendations", json={"scenario_id": scenario_id, "entity_id": entity_id, "currency": currency})).json()
        _audit(scenario_id, "orchestrator", "RECOMMEND", {"rec_id": rec.get("rec_id"), "n_actions": len(rec.get("ranked_actions", []))})
        return rec
