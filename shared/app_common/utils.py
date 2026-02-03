from __future__ import annotations
import uuid
from datetime import datetime, timezone

def now_utc() -> datetime:
    return datetime.now(timezone.utc)

def uid(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:16]}"

def clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))
