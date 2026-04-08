from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Any, Optional
from database import get_conn

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
    status: str


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
                # fallback user so frontend doesn't crash
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
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT id, subject_name, attended_classes, total_classes, required_percentage
                FROM subjects
                WHERE user_id = %s
                ORDER BY subject_name
            """, (user_id,))
            rows = cur.fetchall()

        result = []
        for r in rows:
            attended = int(r["attended_classes"] or 0)
            total = int(r["total_classes"] or 0)
            required = int(r["required_percentage"] or 75)

            percentage = round((attended / total) * 100, 1) if total > 0 else 0.0

            safe_bunks = 0
            if total > 0 and percentage >= required:
                req = required / 100
                safe_bunks = max(0, int((attended / req) - total))

            need_to_recover = 0
            if percentage < required:
                req = required / 100
                x = ((req * total) - attended) / (1 - req) if req < 1 else 0
                need_to_recover = max(0, int(x) if x == int(x) else int(x) + 1)

            status = "Danger"
            if percentage >= required + 5:
                status = "Safe"
            elif percentage >= required:
                status = "Warning"

            result.append({
                "id": r["id"],
                "subject_name": r["subject_name"],
                "attended_classes": attended,
                "total_classes": total,
                "required_percentage": required,
                "attendance_percentage": percentage,
                "safe_bunks": safe_bunks,
                "need_to_recover": need_to_recover,
                "status": status,
            })

        return result
    finally:
        conn.close()


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

from datetime import datetime
from zoneinfo import ZoneInfo

@app.get("/users/{user_id}/dashboard")
def get_dashboard(user_id: int):
    conn = get_conn()
    try:
        india_now = datetime.now(ZoneInfo("Asia/Kolkata"))
        today_name = india_now.strftime("%A")

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
                WHERE user_id = %s AND day_name = %s
                ORDER BY period_no
            """, (user_id, today_name))
            today_rows = cur.fetchall()

        total_present = sum((s.get("attended_classes") or 0) for s in subjects)
        total_classes = sum((s.get("total_classes") or 0) for s in subjects)
        total_absent = max(0, total_classes - total_present)

        current_avg = (
            sum(
                ((s.get("attended_classes") or 0) / (s.get("total_classes") or 1)) * 100
                if (s.get("total_classes") or 0) > 0 else 0
                for s in subjects
            ) / len(subjects)
            if subjects else 0
        )

        overall_percentage = (
            (total_present / total_classes) * 100
            if total_classes > 0 else 0
        )

        today_classes = [
            {
                "period_no": row["period_no"],
                "subject_name": row["subject_name"],
                "marked_status": None,
            }
            for row in today_rows
            if row.get("subject_name")
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

from pydantic import BaseModel

class GoogleUserPayload(BaseModel):
    email: str
    name: str = "Student"


@app.post("/auth/google-user")
def auth_google_user(payload: GoogleUserPayload):
    email = payload.email.strip().lower()

    if not email.endswith("@mlrit.ac.in"):
        raise HTTPException(status_code=403, detail="Only MLRIT accounts allowed")

    conn = get_conn()
    try:
        with conn.cursor() as cur:
            # check existing user
            cur.execute("""
                SELECT id, email, name, college, branch, semester, section, default_target
                FROM users
                WHERE LOWER(email) = %s
            """, (email,))
            user = cur.fetchone()

            if user:
                return user

            # create new user
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
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

@app.get("/users/{user_id}/tomorrow")
def get_tomorrow(user_id: int):
    conn = get_conn()
    try:
        india_now = datetime.now(ZoneInfo("Asia/Kolkata"))
        tomorrow_name = (india_now + timedelta(days=1)).strftime("%A")

        with conn.cursor() as cur:
            cur.execute("""
                SELECT attended_classes, total_classes
                FROM subjects
                WHERE user_id = %s
            """, (user_id,))
            subjects = cur.fetchall()

            cur.execute("""
                SELECT COUNT(*) AS class_count
                FROM timetable
                WHERE user_id = %s
                  AND day_name = %s
                  AND subject_name IS NOT NULL
                  AND TRIM(subject_name) != ''
            """, (user_id, tomorrow_name))
            row = cur.fetchone()

        current_present = sum((s.get("attended_classes") or 0) for s in subjects)
        current_total = sum((s.get("total_classes") or 0) for s in subjects)
        current_pct = (current_present / current_total * 100) if current_total > 0 else 0

        missed_classes = int((row or {}).get("class_count") or 0)
        predicted_total = current_total + missed_classes
        predicted_pct = (current_present / predicted_total * 100) if predicted_total > 0 else 0

        return {
            "title": f"Tomorrow ({tomorrow_name})",
            "current": round(current_pct, 2),
            "new": round(predicted_pct, 2),
            "drop": round(current_pct - predicted_pct, 2),
            "safe": predicted_pct >= 75
        }
    finally:
        conn.close()
@app.get("/users/{user_id}/best-day")
def get_best_day(user_id: int):
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT subject_name, attended_classes, total_classes
                FROM subjects
                WHERE user_id = %s
            """, (user_id,))
            subjects = cur.fetchall()

            cur.execute("""
                SELECT day_name, subject_name
                FROM timetable
                WHERE user_id = %s
                  AND subject_name IS NOT NULL
                  AND TRIM(subject_name) != ''
                ORDER BY day_name, period_no
            """, (user_id,))
            timetable_rows = cur.fetchall()

        if not subjects:
            return {
                "title": "No subjects found",
                "current": 0.0,
                "new": 0.0,
                "drop": 0.0,
                "safe": False
            }

        current_present = sum((s.get("attended_classes") or 0) for s in subjects)
        current_total = sum((s.get("total_classes") or 0) for s in subjects)
        current_overall = (current_present / current_total * 100) if current_total > 0 else 0

        current_avg = (
            sum(
                ((s.get("attended_classes") or 0) / (s.get("total_classes") or 1)) * 100
                if (s.get("total_classes") or 0) > 0 else 0
                for s in subjects
            ) / len(subjects)
        )

        day_map = {}
        for row in timetable_rows:
            day = row["day_name"]
            subject_name = row["subject_name"]
            day_map.setdefault(day, []).append(subject_name)

        if not day_map:
            return {
                "title": "No timetable data",
                "current": round(current_overall, 2),
                "new": round(current_overall, 2),
                "drop": 0.0,
                "safe": current_overall >= 75
            }

        results = []

        for day, day_subjects in day_map.items():
            simulated = [
                {
                    "subject_name": s["subject_name"],
                    "attended_classes": s["attended_classes"],
                    "total_classes": s["total_classes"],
                }
                for s in subjects
            ]

            for scheduled_subject in day_subjects:
                for s in simulated:
                    if s["subject_name"].strip().lower() == scheduled_subject.strip().lower():
                        s["total_classes"] += 1
                        break

            new_present = sum((s["attended_classes"] or 0) for s in simulated)
            new_total = sum((s["total_classes"] or 0) for s in simulated)
            new_overall = (new_present / new_total * 100) if new_total > 0 else 0

            new_avg = (
                sum(
                    (s["attended_classes"] / s["total_classes"] * 100)
                    if s["total_classes"] > 0 else 0
                    for s in simulated
                ) / len(simulated)
            )

            results.append({
                "day": day,
                "new_overall": new_overall,
                "overall_drop": current_overall - new_overall,
                "new_avg": new_avg,
                "avg_drop": current_avg - new_avg,
            })

        # Best = minimum overall drop, tie-break by minimum avg drop
        best = min(
            results,
            key=lambda r: (
                round(r["overall_drop"], 6),
                round(r["avg_drop"], 6),
                r["day"]
            )
        )

        return {
            "title": f"Best Day: {best['day']}",
            "current": round(current_overall, 2),
            "new": round(best["new_overall"], 2),
            "drop": round(best["overall_drop"], 2),
            "safe": best["new_overall"] >= 75
        }

    finally:
        conn.close()
@app.get("/users/{user_id}/worst-day")
def get_worst_day(user_id: int):
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT subject_name, attended_classes, total_classes
                FROM subjects
                WHERE user_id = %s
            """, (user_id,))
            subjects = cur.fetchall()

            cur.execute("""
                SELECT day_name, subject_name
                FROM timetable
                WHERE user_id = %s
                  AND subject_name IS NOT NULL
                  AND TRIM(subject_name) != ''
                ORDER BY day_name, period_no
            """, (user_id,))
            timetable_rows = cur.fetchall()

        if not subjects:
            return {
                "title": "No subjects found",
                "current": 0.0,
                "new": 0.0,
                "drop": 0.0,
                "safe": False
            }

        current_present = sum((s.get("attended_classes") or 0) for s in subjects)
        current_total = sum((s.get("total_classes") or 0) for s in subjects)
        current_overall = (current_present / current_total * 100) if current_total > 0 else 0

        current_avg = (
            sum(
                ((s.get("attended_classes") or 0) / (s.get("total_classes") or 1)) * 100
                if (s.get("total_classes") or 0) > 0 else 0
                for s in subjects
            ) / len(subjects)
        )

        day_map = {}
        for row in timetable_rows:
            day = row["day_name"]
            subject_name = row["subject_name"]
            day_map.setdefault(day, []).append(subject_name)

        if not day_map:
            return {
                "title": "No timetable data",
                "current": round(current_overall, 2),
                "new": round(current_overall, 2),
                "drop": 0.0,
                "safe": current_overall >= 75
            }

        results = []

        for day, day_subjects in day_map.items():
            simulated = [
                {
                    "subject_name": s["subject_name"],
                    "attended_classes": s["attended_classes"],
                    "total_classes": s["total_classes"],
                }
                for s in subjects
            ]

            for scheduled_subject in day_subjects:
                for s in simulated:
                    if s["subject_name"].strip().lower() == scheduled_subject.strip().lower():
                        s["total_classes"] += 1
                        break

            new_present = sum((s["attended_classes"] or 0) for s in simulated)
            new_total = sum((s["total_classes"] or 0) for s in simulated)
            new_overall = (new_present / new_total * 100) if new_total > 0 else 0

            new_avg = (
                sum(
                    (s["attended_classes"] / s["total_classes"] * 100)
                    if s["total_classes"] > 0 else 0
                    for s in simulated
                ) / len(simulated)
            )

            results.append({
                "day": day,
                "new_overall": new_overall,
                "overall_drop": current_overall - new_overall,
                "new_avg": new_avg,
                "avg_drop": current_avg - new_avg,
            })

        # Worst = maximum overall drop, tie-break by maximum avg drop
        worst = max(
            results,
            key=lambda r: (
                round(r["overall_drop"], 6),
                round(r["avg_drop"], 6),
                r["day"]
            )
        )

        return {
            "title": f"Worst Day: {worst['day']}",
            "current": round(current_overall, 2),
            "new": round(worst["new_overall"], 2),
            "drop": round(worst["overall_drop"], 2),
            "safe": worst["new_overall"] >= 75
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
            """, (user_id,))
            subjects = cur.fetchall()

            total_present = sum((s.get("attended_classes") or 0) for s in subjects)
            total_classes = sum((s.get("total_classes") or 0) for s in subjects)

            overall = (total_present / total_classes * 100) if total_classes else 0
            avg = (
                sum(
                    (s["attended_classes"] / s["total_classes"] * 100)
                    if s["total_classes"] else 0
                    for s in subjects
                ) / len(subjects)
            ) if subjects else 0

            from datetime import datetime
            from zoneinfo import ZoneInfo

            today = datetime.now(ZoneInfo("Asia/Kolkata")).strftime("%A")

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