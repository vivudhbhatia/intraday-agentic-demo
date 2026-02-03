from __future__ import annotations
from pydantic import BaseModel, Field
from datetime import datetime
from typing import Literal, Any

Currency = Literal["USD","EUR","GBP"]

class ScenarioStartRequest(BaseModel):
    scenario_id: str = Field(..., description="Scenario name/id")
    seed: int = 42
    start_time_utc: datetime | None = None

class ScenarioStepRequest(BaseModel):
    scenario_id: str
    minutes: int = 5

class RiskStateResponse(BaseModel):
    scenario_id: str
    as_of: datetime
    entity_id: str
    currency: str
    current_balance: float
    early_warning_buffer: float
    buffer_remaining: float
    minutes_to_breach: int | None
    forecast: list[dict[str, Any]]  # [{t, balance}]
    drivers: list[dict[str, Any]]   # [{event_id, ts, dir, amt, ...}]

class RecommendationRequest(BaseModel):
    scenario_id: str
    entity_id: str
    currency: str

class RecommendationResponse(BaseModel):
    rec_id: str
    scenario_id: str
    as_of: datetime
    entity_id: str
    currency: str
    ranked_actions: list[dict[str, Any]]
    explanation: str
