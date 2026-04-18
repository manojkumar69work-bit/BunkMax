from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Any, Optional, Literal
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from database import get_conn
import math

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
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
    subject_name: str
    period_no: int
    status: Literal["present", "absent"]


class SubjectPayload(BaseModel):
    subject_name: str
    attended_classes: int
    total_classes: int
    required_percentage: int = 75


class UserPayload(BaseModel):
    name: str
    college: str
    branch: str
    semester: str
    section: str
    default_target: int = 75


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
    return {"message": "BunkMax backend running 🚀"}


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

            conn.commit()

        return {"message": "Database initialized successfully."}
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
                return {
                    "id": user_id,
                    "name": "",
                    "email": "",
                    "college": "",
                    "branch": "",
                    "semester": "",
                    "section": "",
                    "default_target": 75,
                }

            return {
                "id": user["id"],
                "name": user["name"],
                "email": user["email"],
                "college": user["college"],
                "branch": user["branch"],
                "semester": user["semester"],
                "section": user["section"],
                "default_target": user["default_target"],
            }
    finally:
        conn.close()


@app.put("/users/{user_id}")
def update_user(user_id: int, payload: UserPayload):
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM users WHERE id = %s", (user_id,))
            existing = cur.fetchone()

            if existing:
                cur.execute("""
                    UPDATE users
                    SET name = %s,
                        college = %s,
                        branch = %s,
                        semester = %s,
                        section = %s,
                        default_target = %s
                    WHERE id = %s
                """, (
                    payload.name,
                    payload.college,
                    payload.branch,
                    payload.semester,
                    payload.section,
                    payload.default_target,
                    user_id,
                ))
            else:
                cur.execute("""
                    INSERT INTO users (
                        id, name, email, college, branch, semester, section, default_target
                    )
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                """, (
                    user_id,
                    payload.name,
                    "",
                    payload.college,
                    payload.branch,
                    payload.semester,
                    payload.section,
                    payload.default_target,
                ))

            conn.commit()

        return {"message": "Profile updated successfully."}
    finally:
        conn.close()


@app.post("/auth/google-user")
def auth_google_user(payload: GoogleUserPayload):
    email = payload.email.strip().lower()

    if not email.endswith("@mlrit.ac.in"):
        raise HTTPException(status_code=403, detail="Only MLRIT accounts allowed")

    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT id, email, name, college, branch, semester, section, default_target
                FROM users
                WHERE LOWER(email) = %s
            """, (email,))
            user = cur.fetchone()

            if user:
                return user

            cur.execute("""
                INSERT INTO users (email, name, college, branch, semester, section, default_target)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                RETURNING id, email, name, college, branch, semester, section, default_target
            """, (
                email,
                payload.name or "Student",
                "MLRIT",
                "",
                "",
                "",
                75,
            ))
            new_user = cur.fetchone()
            conn.commit()

            return new_user
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
                subject_id = str(subject.get("subjectid", "")).strip()
                subject_name = str(subject.get("subject_name", "")).strip()

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

        return {
            "message": f"{imported} subjects imported successfully.",
            "subjects_imported": imported,
        }
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

        return {"message": "Subject saved successfully."}
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
            """, (subject_id, user_id))
            conn.commit()

        return {"message": "Subject deleted successfully."}
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
    finally:
        conn.close()


# ---------------------------
# DASHBOARD
# ---------------------------

@app.get("/users/{user_id}/dashboard")
def get_dashboard(user_id: int):
    conn = get_conn()
    try:
        today_name = get_today_name()

        with conn.cursor() as cur:
            cur.execute("""
                SELECT subject_name, attended_classes, total_classes
                FROM subjects
                WHERE user_id = %s
            """, (user_id,))
            subjects = cur.fetchall()

            cur.execute("""
                SELECT period_no, subject_name
                FROM timetable
                WHERE user_id = %s
                  AND day_name = %s
                  AND subject_name IS NOT NULL
                  AND TRIM(subject_name) != ''
                ORDER BY period_no
            """, (user_id, today_name))
            today_rows = cur.fetchall()

        total_present = sum(int(s.get("attended_classes") or 0) for s in subjects)
        total_classes = sum(int(s.get("total_classes") or 0) for s in subjects)
        total_absent = max(0, total_classes - total_present)

        current_avg = calc_avg(subjects)
        overall_percentage = calc_overall(subjects)

        today_classes = [
            {
                "period_no": row["period_no"],
                "subject_name": row["subject_name"],
                "marked_status": None,
            }
            for row in today_rows
        ]

        return {
            "current_avg": round(current_avg, 2),
            "overall_percentage": round(overall_percentage, 2),
            "total_present": total_present,
            "total_absent": total_absent,
            "today_classes": today_classes,
        }
    finally:
        conn.close()


@app.get("/users/{user_id}/home-data")
def get_home_data(user_id: int):
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT subject_name, attended_classes, total_classes
                FROM subjects
                WHERE user_id = %s
                ORDER BY subject_name
            """, (user_id,))
            subjects = cur.fetchall()

            total_present = sum(int(s.get("attended_classes") or 0) for s in subjects)
            total_classes = sum(int(s.get("total_classes") or 0) for s in subjects)

            overall = calc_overall(subjects)
            avg = calc_avg(subjects)

            today = get_today_name()

            cur.execute("""
                SELECT period_no, subject_name
                FROM timetable
                WHERE user_id = %s
                  AND day_name = %s
                  AND subject_name IS NOT NULL
                  AND TRIM(subject_name) != ''
                ORDER BY period_no
            """, (user_id, today))
            today_rows = cur.fetchall()

            today_classes = [
                {
                    "period_no": row["period_no"],
                    "subject_name": row["subject_name"],
                    "marked_status": None,
                }
                for row in today_rows
            ]

        return {
            "dashboard": {
                "current_avg": round(avg, 2),
                "overall_percentage": round(overall, 2),
                "total_present": total_present,
                "total_absent": max(0, total_classes - total_present),
                "today_classes": today_classes,
            },
            "subjects": subjects
        }
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
            if payload.status == "present":
                cur.execute("""
                    UPDATE subjects
                    SET attended_classes = attended_classes + 1,
                        total_classes = total_classes + 1
                    WHERE user_id = %s AND subject_name = %s
                """, (user_id, payload.subject_name))
            else:
                cur.execute("""
                    UPDATE subjects
                    SET total_classes = total_classes + 1
                    WHERE user_id = %s AND subject_name = %s
                """, (user_id, payload.subject_name))

            conn.commit()

        return {"message": "Marked successfully"}
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
                        ELSE 7
                    END,
                    period_no
            """, (user_id,))
            rows = cur.fetchall()

        return rows
    finally:
        conn.close()


@app.post("/users/{user_id}/schedule")
def save_schedule(user_id: int, payload: list[ScheduleEntry]):
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            for item in payload:
                cur.execute("""
                    INSERT INTO timetable (user_id, day_name, period_no, subject_name)
                    VALUES (%s, %s, %s, %s)
                    ON CONFLICT (user_id, day_name, period_no)
                    DO UPDATE SET subject_name = EXCLUDED.subject_name
                """, (
                    user_id,
                    item.day_name,
                    item.period_no,
                    item.subject_name,
                ))

            conn.commit()

        return {"message": "Schedule saved successfully."}
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

    # 🔥 Find NEXT VALID CLASS DAY (skip Sunday / empty days)
    today_idx = datetime.now(ZoneInfo("Asia/Kolkata")).weekday()  # 0=Mon

    next_day_name = None

    for i in range(1, 8):
        day_name = WEEKDAYS[(today_idx + i) % len(WEEKDAYS)]

        if day_name in day_map and len(day_map[day_name]) > 0:
            next_day_name = day_name
            break

    # fallback (no timetable)
    if not next_day_name:
        return {
            "title": "No upcoming classes",
            "new_overall": round(current_overall, 2),
            "drop_overall": 0.0,
            "new_avg": round(current_avg, 2),
            "drop_avg": 0.0,
        }

    # simulate absence
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