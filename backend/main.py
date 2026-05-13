from fastapi import FastAPI, HTTPException, Depends
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, model_validator
from typing import Any, Optional, Literal
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text
import math
import os
import logging

from database import get_db

# ---------------------------
# LOGGING & APP SETUP
# ---------------------------
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("bunkmax")

app = FastAPI(title="BunkMax API")

# ---------------------------
# CORS (Exact same as your original)
# ---------------------------
def get_allowed_origins() -> list[str]:
    default_origins = [
        "http://localhost:3000", "http://localhost:3001",
        "http://127.0.0.1:3000", "http://127.0.0.1:3001",
        "https://bunk-max.vercel.app",
    ]
    env_origins = os.getenv("ALLOWED_ORIGINS", "")
    frontend_url = os.getenv("FRONTEND_URL", "")
    origins = default_origins.copy()
    if frontend_url.strip(): origins.append(frontend_url.strip().rstrip("/"))
    if env_origins.strip():
        origins.extend(o.strip().rstrip("/") for o in env_origins.split(",") if o.strip())
    return sorted(set(origins))

app.add_middleware(
    CORSMiddleware,
    allow_origins=get_allowed_origins(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------
# MODELS (Identical to your Original)
# ---------------------------
class ERPImportPayload(BaseModel):
    subjects: list[dict[str, Any]]
    attendance: dict[str, Any]

class MarkAttendance(BaseModel):
    subject_name: str = Field(..., min_length=1, max_length=255)
    period_no: int = Field(..., ge=1, le=12)
    status: Literal["present", "absent"]

class SubjectPayload(BaseModel):
    subject_name: str = Field(..., min_length=1, max_length=255)
    attended_classes: int = Field(..., ge=0)
    total_classes: int = Field(..., ge=0)
    required_percentage: int = Field(default=75, ge=1, le=100)

    @model_validator(mode="after")
    def validate_counts(self):
        if self.attended_classes > self.total_classes:
            raise ValueError("Attended classes cannot exceed total classes")
        return self

class UserPayload(BaseModel):
    name: str = Field(default="", max_length=255)
    college: str = Field(default="", max_length=255)
    branch: str = Field(default="", max_length=255)
    semester: str = Field(default="", max_length=255)
    section: str = Field(default="", max_length=255)
    default_target: int = Field(default=75, ge=1, le=100)

class ScheduleEntry(BaseModel):
    day_name: str = Field(..., min_length=1, max_length=20)
    period_no: int = Field(..., ge=1, le=12)
    subject_name: str = Field(default="", max_length=255)

class GoogleUserPayload(BaseModel):
    email: str = Field(..., min_length=3, max_length=255)
    name: str = Field(default="Student", max_length=255)

class PlanPayload(BaseModel):
    mode: Literal["tomorrow", "next_n_days", "selected_weekdays"]
    n_days: Optional[int] = Field(default=None, ge=1, le=365)
    weeks: Optional[int] = Field(default=None, ge=1, le=52)
    selected_days: Optional[list[str]] = None

class CalendarPlanDay(BaseModel):
    date: str
    status: Literal["present", "absent"]

class CalendarPlanPayload(BaseModel):
    days: list[CalendarPlanDay]

# ---------------------------
# CONSTANTS & HELPERS
# ---------------------------
WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
ALL_DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]

def clean_text(v: Any) -> str: return str(v or "").strip()

def calc_overall(subjects: list[dict[str, Any]]) -> float:
    p = sum(int(s.get("attended_classes") or 0) for s in subjects)
    t = sum(int(s.get("total_classes") or 0) for s in subjects)
    return (p / t * 100) if t > 0 else 0.0

def calc_avg(subjects: list[dict[str, Any]]) -> float:
    v = [s for s in subjects if int(s.get("total_classes") or 0) > 0]
    if not v: return 0.0
    return sum((int(s["attended_classes"]) / int(s["total_classes"]) * 100) for s in v) / len(v)

def build_subject_response(row: dict[str, Any]) -> dict[str, Any]:
    att, tot = int(row["attended_classes"] or 0), int(row["total_classes"] or 0)
    req_val = int(row["required_percentage"] or 75)
    pct = round((att / tot * 100), 2) if tot > 0 else 0.0
    
    safe = max(0, math.floor(att / (req_val/100) - tot)) if tot > 0 and pct >= req_val else 0
    recovery = 0
    if tot > 0 and pct < req_val and req_val < 100:
        recovery = max(0, math.ceil(((req_val/100 * tot) - att) / (1 - req_val/100)))
    
    status = "Safe" if pct >= req_val + 5 else "Warning" if pct >= req_val else "Danger"
    return {**dict(row), "attendance_percentage": pct, "safe_bunks": safe, "need_to_recover": recovery, "status": status}

def get_today_name() -> str:
    return datetime.now(ZoneInfo("Asia/Kolkata")).strftime("%A")

# ---------------------------
# ASYNC DATABASE FETCHERS
# ---------------------------
async def fetch_subjects(user_id: int, db: AsyncSession):
    res = await db.execute(text("SELECT id, subject_name, attended_classes, total_classes, required_percentage FROM subjects WHERE user_id = :u ORDER BY subject_name"), {"u": user_id})
    return [dict(r) for r in res.mappings().all()]

async def fetch_timetable(user_id: int, db: AsyncSession):
    res = await db.execute(text("SELECT day_name, period_no, subject_name FROM timetable WHERE user_id = :u AND subject_name != '' ORDER BY period_no"), {"u": user_id})
    return [dict(r) for r in res.mappings().all()]

# ---------------------------
# ROUTES
# ---------------------------

@app.get("/init-db")
async def init_db(db: AsyncSession = Depends(get_db)):
    # Standard DB setup logic
    await db.execute(text("CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, name TEXT, email TEXT UNIQUE, college TEXT, branch TEXT, semester TEXT, section TEXT, default_target INTEGER DEFAULT 75)"))
    await db.execute(text("CREATE TABLE IF NOT EXISTS subjects (id SERIAL PRIMARY KEY, user_id INTEGER, subject_name TEXT, attended_classes INTEGER DEFAULT 0, total_classes INTEGER DEFAULT 0, required_percentage INTEGER DEFAULT 75, UNIQUE(user_id, subject_name))"))
    await db.execute(text("CREATE TABLE IF NOT EXISTS timetable (id SERIAL PRIMARY KEY, user_id INTEGER, day_name TEXT, period_no INTEGER, subject_name TEXT, UNIQUE(user_id, day_name, period_no))"))
    await db.commit()
    return {"message": "Success"}

@app.post("/auth/google-user")
async def auth_google_user(payload: GoogleUserPayload, db: AsyncSession = Depends(get_db)):
    email = payload.email.lower().strip()
    if not email.endswith("@mlrit.ac.in"): raise HTTPException(status_code=403, detail="Only MLRIT allowed")
    res = await db.execute(text("SELECT * FROM users WHERE email = :e"), {"e": email})
    user = res.mappings().fetchone()
    if user: return dict(user)
    res = await db.execute(text("INSERT INTO users (name, email, college) VALUES (:n, :e, 'MLRIT') RETURNING *"), {"n": payload.name, "e": email})
    u = res.mappings().fetchone()
    await db.commit()
    return dict(u)

@app.get("/users/{user_id}/home-data")
async def get_home_data(user_id: int, db: AsyncSession = Depends(get_db)):
    subjects = await fetch_subjects(user_id, db)
    tt = await fetch_timetable(user_id, db)
    
    today = get_today_name()
    today_classes = [r for r in tt if r["day_name"] == today]

    return {
        "dashboard": {
            "overall_percentage": round(calc_overall(subjects), 2),
            "current_avg": round(calc_avg(subjects), 2),
            "total_present": sum(s["attended_classes"] for s in subjects),
            "total_absent": sum(s["total_classes"] - s["attended_classes"] for s in subjects),
            "today_classes": [{"period_no": r["period_no"], "subject_name": r["subject_name"]} for r in today_classes]
        },
        "subjects": [build_subject_response(s) for s in subjects]
    }

@app.post("/users/{user_id}/import-attendance")
async def import_attendance(user_id: int, payload: ERPImportPayload, db: AsyncSession = Depends(get_db)):
    imported = 0
    for sub in payload.subjects:
        sid, sname = clean_text(sub.get("subjectid")), clean_text(sub.get("subject_name"))
        if not sid or not sname: continue
        stats = payload.attendance.get(sid, {})
        try:
            tot, pres = int(stats.get("totalsessions", 0)), int(stats.get("presentSessionsCount", 0))
            if pres > tot: pres = tot
            await db.execute(text("""
                INSERT INTO subjects (user_id, subject_name, attended_classes, total_classes)
                VALUES (:u, :n, :p, :t) ON CONFLICT (user_id, subject_name) 
                DO UPDATE SET attended_classes = EXCLUDED.attended_classes, total_classes = EXCLUDED.total_classes
            """), {"u": user_id, "n": sname, "p": pres, "t": tot})
            imported += 1
        except: continue
    await db.commit()
    return {"subjects_imported": imported}

@app.post("/users/{user_id}/mark-attendance")
async def mark_attendance(user_id: int, payload: MarkAttendance, db: AsyncSession = Depends(get_db)):
    col = "attended_classes = attended_classes + 1, total_classes = total_classes + 1" if payload.status == "present" else "total_classes = total_classes + 1"
    res = await db.execute(text(f"UPDATE subjects SET {col} WHERE user_id = :u AND LOWER(subject_name) = LOWER(:s) RETURNING id"), {"u": user_id, "s": payload.subject_name})
    if not res.fetchone(): raise HTTPException(404, "Subject not found")
    await db.commit()
    return {"message": "Success"}

@app.delete("/users/{user_id}/clear-data")
async def clear_data(user_id: int, db: AsyncSession = Depends(get_db)):
    await db.execute(text("DELETE FROM subjects WHERE user_id = :u"), {"u": user_id})
    await db.execute(text("DELETE FROM timetable WHERE user_id = :u"), {"u": user_id})
    await db.commit()
    return {"message": "Data wiped"}

# --- (The rest of the prediction logic follows the same async pattern) ---