from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, model_validator
from typing import Any, Optional, Literal
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from database import get_conn
import math
import os
import logging


# ---------------------------
# LOGGING
# ---------------------------

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("bunkmax")


# ---------------------------
# APP
# ---------------------------

app = FastAPI(title="BunkMax API")


# ---------------------------
# CORS
# ---------------------------

def get_allowed_origins() -> list[str]:
    default_origins = [
        "http://localhost:3000",
        "http://localhost:3001",
        "http://127.0.0.1:3000",
        "http://127.0.0.1:3001",
        "https://bunk-max.vercel.app",
    ]

    env_origins = os.getenv("ALLOWED_ORIGINS", "")
    frontend_url = os.getenv("FRONTEND_URL", "")

    origins = default_origins.copy()

    if frontend_url.strip():
        origins.append(frontend_url.strip().rstrip("/"))

    if env_origins.strip():
        origins.extend(
            origin.strip().rstrip("/")
            for origin in env_origins.split(",")
            if origin.strip()
        )

    return sorted(set(origins))


app.add_middleware(
    CORSMiddleware,
    allow_origins=get_allowed_origins(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------
# MODELS
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
# CONSTANTS
# ---------------------------

WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
ALL_DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
VALID_DAYS = set(ALL_DAYS)


# ---------------------------
# HELPERS
# ---------------------------

def clean_text(value: Any) -> str:
    return str(value or "").strip()


def calc_overall(subjects: list[dict[str, Any]]) -> float:
    present = sum(int(s.get("attended_classes") or 0) for s in subjects)
    total = sum(int(s.get("total_classes") or 0) for s in subjects)
    return (present / total * 100) if total > 0 else 0.0


def calc_avg(subjects: list[dict[str, Any]]) -> float:
    valid_subjects = [
        s for s in subjects
        if int(s.get("total_classes") or 0) > 0
    ]

    if not valid_subjects:
        return 0.0

    total_pct = 0.0

    for s in valid_subjects:
        attended = int(s.get("attended_classes") or 0)
        total = int(s.get("total_classes") or 0)
        total_pct += (attended / total) * 100

    return total_pct / len(valid_subjects)


def build_subject_response(row: dict[str, Any]) -> dict[str, Any]:
    attended = int(row["attended_classes"] or 0)
    total = int(row["total_classes"] or 0)
    required = int(row["required_percentage"] or 75)

    percentage = round((attended / total) * 100, 2) if total > 0 else 0.0

    safe_bunks = 0
    if total > 0 and percentage >= required:
        req = required / 100
        safe_bunks = max(0, math.floor(attended / req - total))

    need_to_recover = 0
    if total > 0 and percentage < required:
        req = required / 100
        if req < 1:
            x = ((req * total) - attended) / (1 - req)
            need_to_recover = max(0, math.ceil(x))

    status = "Danger"
    if percentage >= required + 5:
        status = "Safe"
    elif percentage >= required:
        status = "Warning"

    return {
        "id": row["id"],
        "subject_name": row["subject_name"],
        "attended_classes": attended,
        "total_classes": total,
        "required_percentage": required,
        "attendance_percentage": percentage,
        "safe_bunks": safe_bunks,
        "need_to_recover": need_to_recover,
        "status": status,
    }


def get_today_name() -> str:
    return datetime.now(ZoneInfo("Asia/Kolkata")).strftime("%A")


def get_next_valid_class_day(day_map: dict[str, list[str]]) -> Optional[str]:
    today_idx = datetime.now(ZoneInfo("Asia/Kolkata")).weekday()

    for i in range(1, 8):
        day_name = WEEKDAYS[(today_idx + i) % len(WEEKDAYS)]
        classes = day_map.get(day_name, [])
        if any(clean_text(c) for c in classes):
            return day_name

    return None


def load_subjects_raw(user_id: int) -> list[dict[str, Any]]:
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT id, subject_name, attended_classes, total_classes, required_percentage
                FROM subjects
                WHERE user_id = %s
                ORDER BY subject_name
            """, (user_id,))
            return cur.fetchall()
    finally:
        conn.close()


def load_subjects_minimal(user_id: int) -> list[dict[str, Any]]:
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT subject_name, attended_classes, total_classes
                FROM subjects
                WHERE user_id = %s
                ORDER BY subject_name
            """, (user_id,))
            return cur.fetchall()
    finally:
        conn.close()


def load_timetable_rows(user_id: int) -> list[dict[str, Any]]:
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT day_name, period_no, subject_name
                FROM timetable
                WHERE user_id = %s
                  AND subject_name IS NOT NULL
                  AND TRIM(subject_name) != ''
                ORDER BY
                    CASE day_name
                        WHEN 'Monday' THEN 1
                        WHEN 'Tuesday' THEN 2
                        WHEN 'Wednesday' THEN 3
                        WHEN 'Thursday' THEN 4
                        WHEN 'Friday' THEN 5
                        WHEN 'Saturday' THEN 6
                        WHEN 'Sunday' THEN 7
                        ELSE 8
                    END,
                    period_no
            """, (user_id,))
            return cur.fetchall()
    finally:
        conn.close()


def build_day_map(timetable_rows: list[dict[str, Any]]) -> dict[str, list[str]]:
    day_map: dict[str, list[str]] = {}

    for row in timetable_rows:
        day = clean_text(row.get("day_name"))
        subject_name = clean_text(row.get("subject_name"))

        if day and subject_name:
            day_map.setdefault(day, []).append(subject_name)

    return day_map


def simulate_absence_for_subjects(
    subjects: list[dict[str, Any]],
    missed_subjects: list[str]
) -> dict[str, float]:
    simulated = [
        {
            "subject_name": s["subject_name"],
            "attended_classes": int(s.get("attended_classes") or 0),
            "total_classes": int(s.get("total_classes") or 0),
        }
        for s in subjects
    ]

    for missed_subject in missed_subjects:
        missed_clean = clean_text(missed_subject).lower()

        for s in simulated:
            if clean_text(s["subject_name"]).lower() == missed_clean:
                s["total_classes"] += 1
                break

    return {
        "new_overall": calc_overall(simulated),
        "new_avg": calc_avg(simulated),
    }


def ensure_user_exists(user_id: int):
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM users WHERE id = %s", (user_id,))
            if not cur.fetchone():
                raise HTTPException(status_code=404, detail="User not found")
    finally:
        conn.close()


# ---------------------------
# ROOT
# ---------------------------

@app.get("/")
def root():
    return {
        "message": "BunkMax API running",
        "allowed_origins": get_allowed_origins(),
    }


# ---------------------------
# INIT DB
# ---------------------------

@app.get("/init-db")
def init_db():
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS users (
                    id SERIAL PRIMARY KEY,
                    name TEXT DEFAULT '',
                    email TEXT DEFAULT '',
                    college TEXT DEFAULT '',
                    branch TEXT DEFAULT '',
                    semester TEXT DEFAULT '',
                    section TEXT DEFAULT '',
                    default_target INTEGER DEFAULT 75
                );
            """)

            cur.execute("""
                CREATE TABLE IF NOT EXISTS subjects (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER NOT NULL,
                    subject_name TEXT NOT NULL,
                    attended_classes INTEGER DEFAULT 0,
                    total_classes INTEGER DEFAULT 0,
                    required_percentage INTEGER DEFAULT 75,
                    UNIQUE(user_id, subject_name)
                );
            """)

            cur.execute("""
                CREATE TABLE IF NOT EXISTS timetable (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER NOT NULL,
                    day_name TEXT NOT NULL,
                    period_no INTEGER NOT NULL,
                    subject_name TEXT DEFAULT '',
                    UNIQUE(user_id, day_name, period_no)
                );
            """)

            cur.execute("CREATE INDEX IF NOT EXISTS idx_subjects_user_id ON subjects(user_id);")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_timetable_user_id ON timetable(user_id);")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_timetable_user_day ON timetable(user_id, day_name);")

            conn.commit()

        logger.info("Database initialized successfully")
        return {"message": "Database initialized successfully."}

    except Exception as e:
        logger.exception("Database initialization failed")
        raise HTTPException(status_code=500, detail="Database initialization failed")
    finally:
        conn.close()


# ---------------------------
# AUTH
# ---------------------------

@app.post("/auth/google-user")
def auth_google_user(payload: GoogleUserPayload):
    email = clean_text(payload.email).lower()
    name = clean_text(payload.name) or "Student"

    if not email.endswith("@mlrit.ac.in"):
        raise HTTPException(status_code=403, detail="Only MLRIT accounts allowed")

    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT id, name, email, college, branch, semester, section, default_target
                FROM users
                WHERE LOWER(email) = %s
            """, (email,))
            user = cur.fetchone()

            if user:
                return user

            cur.execute("""
                INSERT INTO users (name, email, college, branch, semester, section, default_target)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                RETURNING id, name, email, college, branch, semester, section, default_target
            """, (
                name,
                email,
                "MLRIT",
                "",
                "",
                "",
                75,
            ))

            new_user = cur.fetchone()
            conn.commit()

            logger.info(f"New user created: {email}")
            return new_user

    except HTTPException:
        raise
    except Exception:
        logger.exception(f"Auth failed for {email}")
        raise HTTPException(status_code=500, detail="Authentication failed")
    finally:
        conn.close()


# ---------------------------
# USER
# ---------------------------

@app.get("/users/{user_id}")
def get_user(user_id: int):
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT id, name, email, college, branch, semester, section, default_target
                FROM users
                WHERE id = %s
            """, (user_id,))
            user = cur.fetchone()

            if not user:
                raise HTTPException(status_code=404, detail="User not found")

            return user

    except HTTPException:
        raise
    except Exception:
        logger.exception(f"Failed to get user {user_id}")
        raise HTTPException(status_code=500, detail="Failed to fetch user")
    finally:
        conn.close()


@app.put("/users/{user_id}")
def update_user(user_id: int, payload: UserPayload):
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                UPDATE users
                SET name = %s,
                    college = %s,
                    branch = %s,
                    semester = %s,
                    section = %s,
                    default_target = %s
                WHERE id = %s
                RETURNING id
            """, (
                payload.name,
                payload.college,
                payload.branch,
                payload.semester,
                payload.section,
                payload.default_target,
                user_id,
            ))

            updated = cur.fetchone()

            if not updated:
                raise HTTPException(status_code=404, detail="User not found")

            conn.commit()

        return {"message": "Profile updated successfully."}

    except HTTPException:
        raise
    except Exception:
        logger.exception(f"Failed to update user {user_id}")
        raise HTTPException(status_code=500, detail="Failed to update user")
    finally:
        conn.close()


# ---------------------------
# IMPORT ATTENDANCE
# ---------------------------

@app.post("/users/{user_id}/import-attendance")
def import_attendance(user_id: int, payload: ERPImportPayload):
    if not payload.subjects:
        raise HTTPException(status_code=400, detail="No subjects provided")

    conn = get_conn()
    try:
        with conn.cursor() as cur:
            imported = 0

            for subject in payload.subjects:
                subject_id = clean_text(subject.get("subjectid"))
                subject_name = clean_text(subject.get("subject_name"))

                if not subject_id or not subject_name:
                    continue

                stats = payload.attendance.get(subject_id, {})

                try:
                    total = int(stats.get("totalsessions", 0) or 0)
                    present = int(stats.get("presentSessionsCount", 0) or 0)
                except Exception:
                    continue

                if total < 0 or present < 0:
                    continue

                if present > total:
                    present = total

                cur.execute("""
                    INSERT INTO subjects (
                        user_id,
                        subject_name,
                        attended_classes,
                        total_classes,
                        required_percentage
                    )
                    VALUES (%s, %s, %s, %s, %s)
                    ON CONFLICT (user_id, subject_name)
                    DO UPDATE SET
                        attended_classes = EXCLUDED.attended_classes,
                        total_classes = EXCLUDED.total_classes,
                        required_percentage = EXCLUDED.required_percentage
                """, (
                    user_id,
                    subject_name,
                    present,
                    total,
                    75,
                ))

                imported += 1

            conn.commit()

        return {
            "message": f"{imported} subjects imported successfully.",
            "subjects_imported": imported,
        }

    except Exception:
        logger.exception(f"Import failed for user {user_id}")
        raise HTTPException(status_code=500, detail="Import failed")
    finally:
        conn.close()


# ---------------------------
# SUBJECTS
# ---------------------------

@app.get("/users/{user_id}/subjects")
def get_subjects(user_id: int):
    try:
        rows = load_subjects_raw(user_id)
        return [build_subject_response(r) for r in rows]
    except Exception:
        logger.exception(f"Failed to fetch subjects for user {user_id}")
        raise HTTPException(status_code=500, detail="Failed to fetch subjects")


@app.post("/users/{user_id}/subjects")
def save_subject(user_id: int, payload: SubjectPayload):
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO subjects (
                    user_id, subject_name, attended_classes, total_classes, required_percentage
                )
                VALUES (%s, %s, %s, %s, %s)
                ON CONFLICT (user_id, subject_name)
                DO UPDATE SET
                    attended_classes = EXCLUDED.attended_classes,
                    total_classes = EXCLUDED.total_classes,
                    required_percentage = EXCLUDED.required_percentage
            """, (
                user_id,
                payload.subject_name.strip(),
                payload.attended_classes,
                payload.total_classes,
                payload.required_percentage,
            ))

            conn.commit()

        return {"message": "Subject saved successfully."}

    except Exception:
        logger.exception(f"Failed to save subject for user {user_id}")
        raise HTTPException(status_code=500, detail="Failed to save subject")
    finally:
        conn.close()


@app.delete("/users/{user_id}/subjects/{subject_id}")
def delete_subject(user_id: int, subject_id: int):
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                DELETE FROM subjects
                WHERE id = %s AND user_id = %s
                RETURNING id
            """, (subject_id, user_id))

            deleted = cur.fetchone()

            if not deleted:
                raise HTTPException(status_code=404, detail="Subject not found")

            conn.commit()

        return {"message": "Subject deleted successfully."}

    except HTTPException:
        raise
    except Exception:
        logger.exception(f"Failed to delete subject {subject_id}")
        raise HTTPException(status_code=500, detail="Failed to delete subject")
    finally:
        conn.close()


# ---------------------------
# CLEAR DATA
# ---------------------------

@app.delete("/users/{user_id}/clear-data")
def clear_user_data(user_id: int):
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM subjects WHERE user_id = %s", (user_id,))
            cur.execute("DELETE FROM timetable WHERE user_id = %s", (user_id,))
            conn.commit()

        return {"message": "All subjects and timetable data cleared successfully."}

    except Exception:
        logger.exception(f"Failed to clear data for user {user_id}")
        raise HTTPException(status_code=500, detail="Failed to clear data")
    finally:
        conn.close()


# ---------------------------
# DASHBOARD / HOME
# ---------------------------

def build_dashboard_payload(user_id: int):
    subjects = load_subjects_minimal(user_id)
    timetable_rows = load_timetable_rows(user_id)
    day_map = build_day_map(timetable_rows)

    overall_percentage = calc_overall(subjects)
    current_avg = calc_avg(subjects)

    total_present = sum(int(s.get("attended_classes") or 0) for s in subjects)
    total_classes = sum(int(s.get("total_classes") or 0) for s in subjects)
    total_absent = max(0, total_classes - total_present)

    today_name = get_today_name()
    today_classes = day_map.get(today_name, [])

    dashboard = {
        "current_avg": round(current_avg, 2),
        "overall_percentage": round(overall_percentage, 2),
        "total_present": total_present,
        "total_absent": total_absent,
        "today_classes": [
            {
                "period_no": i + 1,
                "subject_name": subj,
                "marked_status": None,
            }
            for i, subj in enumerate(today_classes)
            if clean_text(subj)
        ],
    }

    return dashboard, subjects


@app.get("/users/{user_id}/dashboard")
def get_dashboard(user_id: int):
    try:
        dashboard, _ = build_dashboard_payload(user_id)
        return dashboard
    except Exception:
        logger.exception(f"Failed to load dashboard for user {user_id}")
        raise HTTPException(status_code=500, detail="Failed to load dashboard")


@app.get("/users/{user_id}/home-data")
def get_home_data(user_id: int):
    try:
        dashboard, subjects = build_dashboard_payload(user_id)

        return {
            "dashboard": dashboard,
            "subjects": [
                {
                    "subject_name": s["subject_name"],
                    "attended_classes": int(s.get("attended_classes") or 0),
                    "total_classes": int(s.get("total_classes") or 0),
                }
                for s in subjects
            ],
        }

    except Exception:
        logger.exception(f"Failed to load home data for user {user_id}")
        raise HTTPException(status_code=500, detail="Failed to load home data")


# ---------------------------
# MARK ATTENDANCE
# ---------------------------

@app.post("/users/{user_id}/mark-attendance")
def mark_attendance(user_id: int, payload: MarkAttendance):
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT id
                FROM subjects
                WHERE user_id = %s AND LOWER(subject_name) = LOWER(%s)
            """, (user_id, payload.subject_name.strip()))

            subject = cur.fetchone()

            if not subject:
                raise HTTPException(status_code=404, detail="Subject not found")

            if payload.status == "present":
                cur.execute("""
                    UPDATE subjects
                    SET attended_classes = attended_classes + 1,
                        total_classes = total_classes + 1
                    WHERE user_id = %s AND LOWER(subject_name) = LOWER(%s)
                """, (user_id, payload.subject_name.strip()))
            else:
                cur.execute("""
                    UPDATE subjects
                    SET total_classes = total_classes + 1
                    WHERE user_id = %s AND LOWER(subject_name) = LOWER(%s)
                """, (user_id, payload.subject_name.strip()))

            conn.commit()

        return {"message": "Marked successfully"}

    except HTTPException:
        raise
    except Exception:
        logger.exception("Failed to mark attendance")
        raise HTTPException(status_code=500, detail="Failed to mark attendance")
    finally:
        conn.close()


# ---------------------------
# SCHEDULE
# ---------------------------

@app.get("/users/{user_id}/schedule")
def get_schedule(user_id: int):
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT day_name, period_no, subject_name
                FROM timetable
                WHERE user_id = %s
                ORDER BY
                    CASE day_name
                        WHEN 'Monday' THEN 1
                        WHEN 'Tuesday' THEN 2
                        WHEN 'Wednesday' THEN 3
                        WHEN 'Thursday' THEN 4
                        WHEN 'Friday' THEN 5
                        WHEN 'Saturday' THEN 6
                        WHEN 'Sunday' THEN 7
                        ELSE 8
                    END,
                    period_no
            """, (user_id,))
            return cur.fetchall()

    except Exception:
        logger.exception(f"Failed to fetch schedule for user {user_id}")
        raise HTTPException(status_code=500, detail="Failed to fetch schedule")
    finally:
        conn.close()


@app.post("/users/{user_id}/schedule")
def save_schedule(user_id: int, payload: list[ScheduleEntry]):
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            for item in payload:
                day_name = clean_text(item.day_name)
                subject_name = clean_text(item.subject_name)

                if day_name not in VALID_DAYS:
                    continue

                cur.execute("""
                    INSERT INTO timetable (user_id, day_name, period_no, subject_name)
                    VALUES (%s, %s, %s, %s)
                    ON CONFLICT (user_id, day_name, period_no)
                    DO UPDATE SET subject_name = EXCLUDED.subject_name
                """, (
                    user_id,
                    day_name,
                    item.period_no,
                    subject_name,
                ))

            conn.commit()

        return {"message": "Schedule saved successfully."}

    except Exception:
        logger.exception(f"Failed to save schedule for user {user_id}")
        raise HTTPException(status_code=500, detail="Failed to save schedule")
    finally:
        conn.close()


# ---------------------------
# QUICK ACTIONS
# ---------------------------

@app.get("/users/{user_id}/tomorrow")
def get_tomorrow(user_id: int):
    subjects = load_subjects_minimal(user_id)
    timetable_rows = load_timetable_rows(user_id)
    day_map = build_day_map(timetable_rows)

    current_overall = calc_overall(subjects)
    current_avg = calc_avg(subjects)

    next_day_name = get_next_valid_class_day(day_map)

    if not next_day_name:
        return {
            "title": "No upcoming classes",
            "new_overall": round(current_overall, 2),
            "drop_overall": 0.0,
            "new_avg": round(current_avg, 2),
            "drop_avg": 0.0,
        }

    missed_subjects = day_map.get(next_day_name, [])
    simulated = simulate_absence_for_subjects(subjects, missed_subjects)

    return {
        "title": f"Next Class Day ({next_day_name})",
        "new_overall": round(simulated["new_overall"], 2),
        "drop_overall": round(current_overall - simulated["new_overall"], 2),
        "new_avg": round(simulated["new_avg"], 2),
        "drop_avg": round(current_avg - simulated["new_avg"], 2),
    }


@app.get("/users/{user_id}/best-day")
def get_best_day(user_id: int):
    return _day_logic(user_id, best=True)


@app.get("/users/{user_id}/worst-day")
def get_worst_day(user_id: int):
    return _day_logic(user_id, best=False)


def _day_logic(user_id: int, best: bool):
    subjects = load_subjects_minimal(user_id)
    timetable_rows = load_timetable_rows(user_id)
    day_map = build_day_map(timetable_rows)

    current_overall = calc_overall(subjects)
    current_avg = calc_avg(subjects)

    if not subjects:
        return {
            "title": "No subjects found",
            "new_overall": 0.0,
            "drop_overall": 0.0,
            "new_avg": 0.0,
            "drop_avg": 0.0,
        }

    results = []

    for day in WEEKDAYS:
        missed_subjects = day_map.get(day, [])

        if not missed_subjects:
            continue

        simulated = simulate_absence_for_subjects(subjects, missed_subjects)

        results.append({
            "day": day,
            "new_overall": simulated["new_overall"],
            "drop_overall": current_overall - simulated["new_overall"],
            "new_avg": simulated["new_avg"],
            "drop_avg": current_avg - simulated["new_avg"],
        })

    if not results:
        return {
            "title": "No timetable data",
            "new_overall": round(current_overall, 2),
            "drop_overall": 0.0,
            "new_avg": round(current_avg, 2),
            "drop_avg": 0.0,
        }

    if best:
        chosen = min(
            results,
            key=lambda r: (
                round(r["drop_overall"], 6),
                round(r["drop_avg"], 6),
                r["day"],
            ),
        )
        title = f"Best Day: {chosen['day']}"
    else:
        chosen = max(
            results,
            key=lambda r: (
                round(r["drop_overall"], 6),
                round(r["drop_avg"], 6),
                r["day"],
            ),
        )
        title = f"Worst Day: {chosen['day']}"

    return {
        "title": title,
        "new_overall": round(chosen["new_overall"], 2),
        "drop_overall": round(chosen["drop_overall"], 2),
        "new_avg": round(chosen["new_avg"], 2),
        "drop_avg": round(chosen["drop_avg"], 2),
    }


# ---------------------------
# PLAN BUNKS
# ---------------------------

@app.post("/users/{user_id}/plan-bunks")
def plan_bunks(user_id: int, payload: PlanPayload):
    subjects = load_subjects_minimal(user_id)
    timetable_rows = load_timetable_rows(user_id)
    day_map = build_day_map(timetable_rows)

    current_overall = calc_overall(subjects)
    current_avg = calc_avg(subjects)

    missed_subjects: list[str] = []
    label = ""

    today_idx = datetime.now(ZoneInfo("Asia/Kolkata")).weekday()

    if payload.mode == "tomorrow":
        next_day_name = get_next_valid_class_day(day_map)
        if next_day_name:
            missed_subjects = day_map.get(next_day_name, [])
            label = f"Absent on {next_day_name}"
        else:
            label = "No upcoming classes"

    elif payload.mode == "next_n_days":
        n_days = payload.n_days or 1
        count = 0
        i = 1

        while count < n_days and i <= 365:
            day_name = WEEKDAYS[(today_idx + i) % len(WEEKDAYS)]

            if day_name in day_map and any(clean_text(c) for c in day_map[day_name]):
                missed_subjects.extend(day_map[day_name])
                count += 1

            i += 1

        label = f"Absent for next {count} class days"

    elif payload.mode == "selected_weekdays":
        selected_days = payload.selected_days or []
        weeks = payload.weeks or 1

        for _ in range(weeks):
            for day_name in selected_days:
                if day_name in WEEKDAYS:
                    missed_subjects.extend(day_map.get(day_name, []))

        label = "Absent on selected weekdays"

    simulated = simulate_absence_for_subjects(subjects, missed_subjects)

    return {
        "scenario_label": label,
        "new_overall": round(simulated["new_overall"], 2),
        "drop_overall": round(current_overall - simulated["new_overall"], 2),
        "new_avg": round(simulated["new_avg"], 2),
        "drop_avg": round(current_avg - simulated["new_avg"], 2),
    }


# ---------------------------
# CALENDAR PLAN
# ---------------------------

@app.post("/users/{user_id}/calendar-plan")
def calendar_plan(user_id: int, payload: CalendarPlanPayload):
    if not payload.days:
        raise HTTPException(status_code=400, detail="At least one date is required")

    subjects = load_subjects_minimal(user_id)
    timetable_rows = load_timetable_rows(user_id)
    day_map = build_day_map(timetable_rows)

    current_overall = calc_overall(subjects)
    current_avg = calc_avg(subjects)

    simulated = [
        {
            "subject_name": s["subject_name"],
            "attended_classes": int(s.get("attended_classes") or 0),
            "total_classes": int(s.get("total_classes") or 0),
        }
        for s in subjects
    ]

    total_simulated_sessions = 0
    skipped_dates = []

    for day_plan in payload.days:
        try:
            date_obj = datetime.strptime(day_plan.date, "%Y-%m-%d").date()
        except ValueError:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid date format: {day_plan.date}"
            )

        weekday_num = date_obj.weekday()
        weekday_name = ALL_DAYS[weekday_num]

        if weekday_name == "Sunday":
            skipped_dates.append({
                "date": day_plan.date,
                "reason": "No classes (Sunday)",
            })
            continue

        classes_today = day_map.get(weekday_name, [])

        if not classes_today or all(not clean_text(c) for c in classes_today):
            skipped_dates.append({
                "date": day_plan.date,
                "reason": "No classes scheduled",
            })
            continue

        for class_name in classes_today:
            clean_class = clean_text(class_name)

            if not clean_class:
                continue

            subject = None

            for s in simulated:
                if clean_text(s["subject_name"]).lower() == clean_class.lower():
                    subject = s
                    break

            if not subject:
                continue

            subject["total_classes"] += 1
            total_simulated_sessions += 1

            if day_plan.status == "present":
                subject["attended_classes"] += 1

    new_overall = calc_overall(simulated)
    new_avg = calc_avg(simulated)

    return {
        "scenario_label": "Calendar Prediction",
        "current_overall": round(current_overall, 2),
        "new_overall": round(new_overall, 2),
        "change_overall": round(new_overall - current_overall, 2),
        "current_avg": round(current_avg, 2),
        "new_avg": round(new_avg, 2),
        "change_avg": round(new_avg - current_avg, 2),
        "simulated_sessions": total_simulated_sessions,
        "skipped_dates": skipped_dates,
    }