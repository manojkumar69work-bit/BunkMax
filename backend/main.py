from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, field_validator
from typing import Any, Optional, Literal
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from database import get_conn
import math
import os
import logging

# Setup logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI()

# CORS configuration from environment
ALLOWED_ORIGINS = os.getenv("ALLOWED_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000").split(",")

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE"],
    allow_headers=["Content-Type"],
)

# ---------------------------
# MODELS
# ---------------------------

class ERPImportPayload(BaseModel):
    subjects: list[dict[str, Any]]
    attendance: dict[str, Any]


class MarkAttendance(BaseModel):
    subject_name: str = Field(..., min_length=1, max_length=255)
    period_no: int = Field(..., ge=1, le=6)
    status: Literal["present", "absent"]


class SubjectPayload(BaseModel):
    subject_name: str = Field(..., min_length=1, max_length=255)
    attended_classes: int = Field(..., ge=0)
    total_classes: int = Field(..., ge=0)
    required_percentage: int = Field(default=75, ge=0, le=100)
    
    @field_validator("attended_classes")
    @classmethod
    def attended_not_more_than_total(cls, v, info):
        if "total_classes" in info.data and v > info.data["total_classes"]:
            raise ValueError("Attended classes cannot exceed total classes")
        return v


class UserPayload(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    college: str = Field(..., min_length=1, max_length=255)
    branch: str = Field(..., min_length=1, max_length=255)
    semester: str = Field(..., min_length=1, max_length=255)
    section: str = Field(..., min_length=1, max_length=255)
    default_target: int = Field(default=75, ge=0, le=100)


class ScheduleEntry(BaseModel):
    day_name: str
    period_no: int
    subject_name: str


class GoogleUserPayload(BaseModel):
    email: str
    name: str = "Student"


class PlanPayload(BaseModel):
    mode: Literal["tomorrow", "next_n_days", "selected_weekdays"]
    n_days: Optional[int] = None
    weeks: Optional[int] = None
    selected_days: Optional[list[str]] = None


class CalendarPlanDay(BaseModel):
    date: str  # ISO format: YYYY-MM-DD
    status: Literal["present", "absent"]


class CalendarPlanPayload(BaseModel):
    days: list[CalendarPlanDay]


# ---------------------------
# HELPERS
# ---------------------------

WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]


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
    if percentage < required:
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


def get_tomorrow_name() -> str:
    return (datetime.now(ZoneInfo("Asia/Kolkata")) + timedelta(days=1)).strftime("%A")


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
                        ELSE 7
                    END,
                    period_no
            """, (user_id,))
            return cur.fetchall()
    finally:
        conn.close()


def build_day_map(timetable_rows: list[dict[str, Any]]) -> dict[str, list[str]]:
    day_map: dict[str, list[str]] = {}
    for row in timetable_rows:
        day = row["day_name"]
        subject_name = row["subject_name"]
        if subject_name and str(subject_name).strip():
            day_map.setdefault(day, []).append(subject_name)
    return day_map


def simulate_absence_for_subjects(
    subjects: list[dict[str, Any]],
    missed_subjects: list[str]
) -> dict[str, float]:
    simulated = [
        {
            "subject_name": s["subject_name"],
            "attended_classes": int(s["attended_classes"] or 0),
            "total_classes": int(s["total_classes"] or 0),
        }
        for s in subjects
    ]

    for missed_subject in missed_subjects:
        for s in simulated:
            if s["subject_name"].strip().lower() == str(missed_subject).strip().lower():
                s["total_classes"] += 1
                break

    return {
        "new_overall": calc_overall(simulated),
        "new_avg": calc_avg(simulated),
    }


# ---------------------------
# ROOT
# ---------------------------

@app.get("/")
def root():
    return {"message": "BunkMax API running"}


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

            # Create indexes for faster queries
            cur.execute("CREATE INDEX IF NOT EXISTS idx_subjects_user_id ON subjects(user_id);")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_timetable_user_id ON timetable(user_id);")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_timetable_user_day ON timetable(user_id, day_name);")

            conn.commit()
            logger.info("Database initialized with indexes")

        return {"message": "Database initialized successfully."}
    except Exception as e:
        logger.error(f"Database initialization failed: {e}")
        raise HTTPException(status_code=500, detail="Database initialization failed")
    finally:
        conn.close()


# ---------------------------
# AUTH
# ---------------------------

@app.post("/auth/google-user")
def auth_google_user(payload: GoogleUserPayload):
    email = payload.email.strip().lower()
    name = payload.name.strip() or "Student"

    if not email.endswith("@mlrit.ac.in"):
        raise HTTPException(status_code=403, detail="Only MLRIT accounts allowed")

    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, name, email, college, branch, semester, section, default_target FROM users WHERE email = %s",
                (email,)
            )
            user = cur.fetchone()

            if user:
                logger.info(f"User login: {email}")
                return user

            cur.execute(
                """
                INSERT INTO users (name, email, college, branch, semester, section, default_target)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                RETURNING id, name, email, college, branch, semester, section, default_target
                """,
                (name, email, "MLRIT", "", "", "", 75)
            )
            user = cur.fetchone()
            conn.commit()
            logger.info(f"New user created: {email}")

            return user
    except Exception as e:
        logger.error(f"Auth failed for {email}: {e}")
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
    except Exception as e:
        logger.error(f"Failed to get user {user_id}: {e}")
        raise HTTPException(status_code=500, detail="Failed to fetch user")
    finally:
        conn.close()


@app.put("/users/{user_id}")
def update_user(user_id: int, payload: UserPayload):
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE users
                SET name = %s, college = %s, branch = %s, semester = %s, section = %s, default_target = %s
                WHERE id = %s
                """,
                (
                    payload.name,
                    payload.college,
                    payload.branch,
                    payload.semester,
                    payload.section,
                    payload.default_target,
                    user_id,
                )
            )
            conn.commit()
            logger.info(f"User {user_id} updated")

        return {"message": "User updated successfully."}
    except Exception as e:
        logger.error(f"Failed to update user {user_id}: {e}")
        raise HTTPException(status_code=500, detail="Failed to update user")
    finally:
        conn.close()


# ---------------------------
# IMPORT
# ---------------------------

@app.post("/users/{user_id}/import-attendance")
def import_attendance(user_id: int, payload: ERPImportPayload):
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            imported = 0

            for subject in payload.subjects:
                subject_id = subject.get("subjectid")
                subject_name = subject.get("subject_name", "").strip()

                if not subject_id or not subject_name:
                    continue

                stats = payload.attendance.get(subject_id, {})
                total = int(stats.get("totalsessions", 0) or 0)
                present = int(stats.get("presentSessionsCount", 0) or 0)

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
                """, (user_id, subject_name, present, total, 75))

                imported += 1

            conn.commit()
            logger.info(f"Imported {imported} subjects for user {user_id}")

        return {
            "message": f"{imported} subjects imported successfully.",
            "subjects_imported": imported,
        }
    except Exception as e:
        logger.error(f"Import failed for user {user_id}: {e}")
        raise HTTPException(status_code=500, detail="Import failed")
    finally:
        conn.close()


# ---------------------------
# SUBJECTS
# ---------------------------

@app.get("/users/{user_id}/subjects")
def get_subjects(user_id: int):
    rows = load_subjects_raw(user_id)
    return [build_subject_response(r) for r in rows]


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
                payload.subject_name,
                payload.attended_classes,
                payload.total_classes,
                payload.required_percentage,
            ))
            conn.commit()
            logger.info(f"Subject '{payload.subject_name}' saved for user {user_id}")

        return {"message": "Subject saved successfully."}
    except Exception as e:
        logger.error(f"Failed to save subject for user {user_id}: {e}")
        raise HTTPException(status_code=500, detail="Failed to save subject")
    finally:
        conn.close()


@app.delete("/users/{user_id}/subjects/{subject_id}")
def delete_subject(user_id: int, subject_id: int):
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            # Verify ownership first
            cur.execute(
                "SELECT id FROM subjects WHERE id = %s AND user_id = %s",
                (subject_id, user_id)
            )
            if not cur.fetchone():
                raise HTTPException(status_code=404, detail="Subject not found")
            
            cur.execute(
                "DELETE FROM subjects WHERE id = %s AND user_id = %s",
                (subject_id, user_id)
            )
            conn.commit()
            logger.info(f"Subject {subject_id} deleted by user {user_id}")

        return {"message": "Subject deleted successfully."}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to delete subject: {e}")
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
            logger.info(f"All data cleared for user {user_id}")

        return {"message": "All subjects and timetable data cleared successfully."}
    except Exception as e:
        logger.error(f"Failed to clear data for user {user_id}: {e}")
        raise HTTPException(status_code=500, detail="Failed to clear data")
    finally:
        conn.close()


# ---------------------------
# DASHBOARD
# ---------------------------

@app.get("/users/{user_id}/dashboard")
def get_dashboard(user_id: int):
    subjects = load_subjects_minimal(user_id)
    timetable_rows = load_timetable_rows(user_id)
    day_map = build_day_map(timetable_rows)

    overall_percentage = calc_overall(subjects)
    current_avg = calc_avg(subjects)

    total_present = sum(int(s.get("attended_classes") or 0) for s in subjects)
    total_absent = sum(int(s.get("total_classes") or 0) for s in subjects) - total_present

    today_name = get_today_name()
    today_classes = day_map.get(today_name, [])

    return {
        "current_avg": round(current_avg, 2),
        "overall_percentage": round(overall_percentage, 2),
        "total_present": total_present,
        "total_absent": total_absent,
        "today_classes": [
            {"period_no": i + 1, "subject_name": subj}
            for i, subj in enumerate(today_classes)
            if subj and str(subj).strip()
        ],
    }


@app.get("/users/{user_id}/home-data")
def get_home_data(user_id: int):
    subjects = load_subjects_minimal(user_id)
    timetable_rows = load_timetable_rows(user_id)
    day_map = build_day_map(timetable_rows)

    overall_percentage = calc_overall(subjects)
    current_avg = calc_avg(subjects)

    total_present = sum(int(s.get("attended_classes") or 0) for s in subjects)
    total_absent = sum(int(s.get("total_classes") or 0) for s in subjects) - total_present

    today_name = get_today_name()
    today_classes = day_map.get(today_name, [])

    return {
        "dashboard": {
            "current_avg": round(current_avg, 2),
            "overall_percentage": round(overall_percentage, 2),
            "total_present": total_present,
            "total_absent": total_absent,
            "today_classes": [
                {"period_no": i + 1, "subject_name": subj}
                for i, subj in enumerate(today_classes)
                if subj and str(subj).strip()
            ],
        },
        "subjects": [
            {
                "subject_name": s["subject_name"],
                "attended_classes": int(s.get("attended_classes") or 0),
                "total_classes": int(s.get("total_classes") or 0),
            }
            for s in subjects
        ],
    }


# ---------------------------
# SCHEDULE / TIMETABLE
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
                        ELSE 7
                    END,
                    period_no
            """, (user_id,))
            return cur.fetchall()
    finally:
        conn.close()


@app.post("/users/{user_id}/schedule")
def save_schedule(user_id: int, entries: list[ScheduleEntry]):
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM timetable WHERE user_id = %s", (user_id,))

            for entry in entries:
                cur.execute(
                    """
                    INSERT INTO timetable (user_id, day_name, period_no, subject_name)
                    VALUES (%s, %s, %s, %s)
                    """,
                    (user_id, entry.day_name, entry.period_no, entry.subject_name)
                )

            conn.commit()
            logger.info(f"Schedule saved for user {user_id}")

        return {"message": "Schedule saved successfully."}
    except Exception as e:
        logger.error(f"Failed to save schedule for user {user_id}: {e}")
        raise HTTPException(status_code=500, detail="Failed to save schedule")
    finally:
        conn.close()


# ---------------------------
# MARK ATTENDANCE
# ---------------------------

@app.post("/users/{user_id}/mark-attendance")
def mark_attendance(user_id: int, payload: MarkAttendance):
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id FROM subjects WHERE user_id = %s AND subject_name = %s",
                (user_id, payload.subject_name)
            )
            subject = cur.fetchone()

            if not subject:
                raise HTTPException(status_code=404, detail="Subject not found")

            if payload.status == "present":
                cur.execute(
                    """
                    UPDATE subjects
                    SET attended_classes = attended_classes + 1, total_classes = total_classes + 1
                    WHERE user_id = %s AND subject_name = %s
                    """,
                    (user_id, payload.subject_name)
                )
            else:
                cur.execute(
                    """
                    UPDATE subjects
                    SET total_classes = total_classes + 1
                    WHERE user_id = %s AND subject_name = %s
                    """,
                    (user_id, payload.subject_name)
                )

            conn.commit()
            logger.info(f"Attendance marked for user {user_id}: {payload.subject_name} - {payload.status}")

        return {"message": "Attendance marked successfully."}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to mark attendance: {e}")
        raise HTTPException(status_code=500, detail="Failed to mark attendance")
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

    if not subjects:
        return {
            "title": "No subjects found",
            "new_overall": 0.0,
            "drop_overall": 0.0,
            "new_avg": 0.0,
            "drop_avg": 0.0,
        }

    current_overall = calc_overall(subjects)
    current_avg = calc_avg(subjects)

    tomorrow_name = get_tomorrow_name()
    missed_subjects = day_map.get(tomorrow_name, [])

    simulated = simulate_absence_for_subjects(subjects, missed_subjects)

    return {
        "title": f"Next Class Day ({tomorrow_name})",
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

    if not subjects:
        return {
            "title": "No subjects found",
            "new_overall": 0.0,
            "drop_overall": 0.0,
            "new_avg": 0.0,
            "drop_avg": 0.0,
        }

    if not day_map:
        current_overall = calc_overall(subjects)
        current_avg = calc_avg(subjects)
        return {
            "title": "No timetable data",
            "new_overall": round(current_overall, 2),
            "drop_overall": 0.0,
            "new_avg": round(current_avg, 2),
            "drop_avg": 0.0,
        }

    current_overall = calc_overall(subjects)
    current_avg = calc_avg(subjects)

    results = []

    for day, missed_subjects in day_map.items():
        simulated = simulate_absence_for_subjects(subjects, missed_subjects)

        new_overall = simulated["new_overall"]
        new_avg = simulated["new_avg"]

        results.append({
            "day": day,
            "new_overall": new_overall,
            "drop_overall": current_overall - new_overall,
            "new_avg": new_avg,
            "drop_avg": current_avg - new_avg,
        })

    if best:
        chosen = min(
            results,
            key=lambda r: (
                round(r["drop_overall"], 6),
                round(r["drop_avg"], 6),
                r["day"]
            )
        )
        title = f"Best Day: {chosen['day']}"
    else:
        chosen = max(
            results,
            key=lambda r: (
                round(r["drop_overall"], 6),
                round(r["drop_avg"], 6),
                r["day"]
            )
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

    today_idx = datetime.now(ZoneInfo("Asia/Kolkata")).weekday()

    missed_subjects: list[str] = []
    label = ""

    if payload.mode == "tomorrow":
        tomorrow_name = get_tomorrow_name()
        missed_subjects = day_map.get(tomorrow_name, [])
        label = "Absent tomorrow"

    elif payload.mode == "next_n_days":
        n_days = payload.n_days or 1
        count = 0
        i = 1

        while count < n_days:
            day_name = WEEKDAYS[(today_idx + i) % len(WEEKDAYS)]
            if day_name in day_map:
                missed_subjects.extend(day_map[day_name])
                count += 1
            i += 1

        label = f"Absent for next {n_days} class days"

    elif payload.mode == "selected_weekdays":
        selected_days = payload.selected_days or []
        weeks = payload.weeks or 1

        for _ in range(weeks):
            for day_name in selected_days:
                missed_subjects.extend(day_map.get(day_name, []))

        label = "Absent on selected weekdays"

    simulated = simulate_absence_for_subjects(subjects, missed_subjects)
    new_overall = simulated["new_overall"]
    new_avg = simulated["new_avg"]

    return {
        "scenario_label": label,
        "new_overall": round(new_overall, 2),
        "drop_overall": round(current_overall - new_overall, 2),
        "new_avg": round(new_avg, 2),
        "drop_avg": round(current_avg - new_avg, 2),
    }


# ---------------------------
# CALENDAR PLAN
# ---------------------------

@app.post("/users/{user_id}/calendar-plan")
def calendar_plan(user_id: int, payload: CalendarPlanPayload):
    """
    Simulate attendance for user-selected dates.
    Prediction only - does not update database.
    """
    
    # Validate input
    if not payload.days:
        raise HTTPException(status_code=400, detail="At least one date is required")
    
    # Load current data
    subjects = load_subjects_minimal(user_id)
    timetable_rows = load_timetable_rows(user_id)
    day_map = build_day_map(timetable_rows)
    
    # Calculate current metrics
    current_overall = calc_overall(subjects)
    current_avg = calc_avg(subjects)
    
    # Create simulation (deep copy)
    simulated = [
        {
            "subject_name": s["subject_name"],
            "attended_classes": int(s.get("attended_classes") or 0),
            "total_classes": int(s.get("total_classes") or 0),
        }
        for s in subjects
    ]
    
    # Weekday names for conversion
    WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
    
    total_simulated_sessions = 0
    skipped_dates = []
    
    # Process each selected date
    for day_plan in payload.days:
        try:
            # Parse date
            date_obj = datetime.strptime(day_plan.date, "%Y-%m-%d").date()
        except ValueError:
            raise HTTPException(status_code=400, detail=f"Invalid date format: {day_plan.date}")
        
        # Get weekday (0=Monday, 6=Sunday)
        weekday_num = date_obj.weekday()
        
        # Skip Sunday
        if weekday_num == 6:
            skipped_dates.append({
                "date": day_plan.date,
                "reason": "No classes (Sunday)"
            })
            continue
        
        # Get weekday name
        weekday_name = WEEKDAY_NAMES[weekday_num]
        
        # Get classes for this day
        classes_today = day_map.get(weekday_name, [])
        
        # Skip if no classes
        if not classes_today or all(not str(c or "").strip() for c in classes_today):
            skipped_dates.append({
                "date": day_plan.date,
                "reason": "No classes scheduled"
            })
            continue
        
        # Apply status to each class
        for class_name in classes_today:
            clean_class = str(class_name or "").strip()
            if not clean_class:
                continue
            
            # Find subject in simulated
            subject = None
            for s in simulated:
                if s["subject_name"].strip().lower() == clean_class.lower():
                    subject = s
                    break
            
            if not subject:
                # Subject in timetable but not in subjects table - skip safely
                continue
            
            # Update counts
            subject["total_classes"] += 1
            total_simulated_sessions += 1
            
            if day_plan.status == "present":
                subject["attended_classes"] += 1
    
    # Calculate new metrics
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