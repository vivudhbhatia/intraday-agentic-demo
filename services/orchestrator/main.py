from __future__ import annotations

import os
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import httpx

from shared.app_common.utils import uid, now_utc
from shared.app_common.db import exec_sql
from shared.app_common.models import RecommendationResponse

from pydantic import BaseModel
from typing import Any, Dict, Optional


app = FastAPI(title="orchestrator-service")

# Demo-safe CORS (for browser UI on a different Cloud Run domain)
# If you want to lock it down later, replace "*" with your ui-service URL.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Prefer env vars (Cloud Run), fall back to internal DNS (future: same VPC/Cloud Run service-to-service)
SIM_URL = os.getenv("SIM_URL", "http://simulator-service:8080")
RISK_URL = os.getenv("RISK_URL", "http://risk-engine-service:8080")
DEC_URL  = os.getenv("DEC_URL",  "http://decision-engine-service:8080")

def _audit(scenario_id: str, service: str, action: str, details: dict):
    # Store as JSONB safely (minimal risk of quote issues)
    exec_sql(
        """
        INSERT INTO audit_log(audit_id, scenario_id, ts, service, action, details)
        VALUES (%(id)s, %(s)s, %(ts)s, %(svc)s, %(act)s, %(d)s::jsonb)
        """,
        {
            "id": uid("AUD"),
            "s": scenario_id,
            "ts": now_utc(),
            "svc": service,
            "act": action,
            # Convert dict->json string without relying on str()
            "d": __import__("json").dumps(details),
        },
    )

@app.get("/health")
def health():
    return {"ok": True}

@app.post("/run_cycle", response_model=RecommendationResponse)
async def run_cycle(scenario_id: str, entity_id: str = "E1", currency: str = "USD"):
    async with httpx.AsyncClient(timeout=30.0) as client:
        _audit(scenario_id, "orchestrator", "ASSESS_START", {"currency": currency, "entity_id": entity_id})

        # 1) Pull risk state
        risk_resp = await client.get(
            f"{RISK_URL}/risk_state",
            params={"scenario_id": scenario_id, "entity_id": entity_id, "currency": currency},
        )
        risk_resp.raise_for_status()
        risk = risk_resp.json()

        _audit(
            scenario_id,
            "orchestrator",
            "RISK_STATE",
            {
                "minutes_to_breach": risk.get("minutes_to_breach"),
                "buffer_remaining": risk.get("buffer_remaining"),
                "early_warning_buffer": risk.get("early_warning_buffer"),
            },
        )

        # 2) If no breach projected within horizon, return no-action recommendation
        mtb = risk.get("minutes_to_breach")
        buffer_remaining = float(risk.get("buffer_remaining", 0) or 0)

        if mtb is None and buffer_remaining > 0:
            rec = {
                "rec_id": uid("REC"),
                "scenario_id": scenario_id,
                "as_of": risk.get("as_of", now_utc()),
                "entity_id": entity_id,
                "currency": currency,
                "ranked_actions": [],
                "explanation": "No early-warning breach projected in forecast horizon. No action recommended.",
            }
            _audit(scenario_id, "orchestrator", "NO_ACTION", rec)
            return rec

        # 3) Request recommendations from decision engine
        dec_resp = await client.post(
            f"{DEC_URL}/recommendations",
            json={"scenario_id": scenario_id, "entity_id": entity_id, "currency": currency},
        )
        dec_resp.raise_for_status()
        rec = dec_resp.json()

        _audit(
            scenario_id,
            "orchestrator",
            "RECOMMEND",
            {"rec_id": rec.get("rec_id"), "n_actions": len(rec.get("ranked_actions", []) or [])},
        )
        return rec

class ApprovalRequest(BaseModel):
    scenario_id: str
    entity_id: str = "E1"
    currency: str = "USD"
    decision: str  # APPROVE / REJECT
    action: Dict[str, Any]

@app.post("/actions/approve")
async def approve_action(req: ApprovalRequest):
    approval_id = uid("APR")
    exec_sql(
        """
        INSERT INTO action_approvals(approval_id, scenario_id, ts, entity_id, currency, decision, action)
        VALUES (%(id)s, %(s)s, %(ts)s, %(e)s, %(c)s, %(d)s, %(a)s::jsonb)
        """,
        {
            "id": approval_id,
            "s": req.scenario_id,
            "ts": now_utc(),
            "e": req.entity_id,
            "c": req.currency,
            "d": req.decision,
            "a": __import__("json").dumps(req.action),
        },
    )

    _audit(req.scenario_id, "orchestrator", "ACTION_"+req.decision, {"approval_id": approval_id, "action": req.action})
    return {"ok": True, "approval_id": approval_id}

