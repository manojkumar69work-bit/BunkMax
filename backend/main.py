import math
import sqlite3
import datetime
from collections import Counter
from typing import List, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

app = FastAPI(title="BunkMax API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

DB_PATH = "attendance.db"
DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
PERIODS = 6


def get_conn():
    conn = sqlite3.connect(
        DB_PATH,
        timeout=30,
        check_same_thread=False,
        isolation_level=None,
    )
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA busy_timeout = 30000;")
    return conn


def init_db():
    conn = get_conn()
    cur = conn.cursor()

    cur.execute("""
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE,
        name TEXT NOT NULL,
        college TEXT DEFAULT 'MLR Institute of Technology',
        branch TEXT DEFAULT '',
        semester TEXT DEFAULT '',
        section TEXT DEFAULT '',
        default_target REAL DEFAULT 75
    )
    """)

    cur.execute("""
    CREATE TABLE IF NOT EXISTS subjects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        subject_name TEXT NOT NULL,
        attended_classes INTEGER DEFAULT 0,
        total_classes INTEGER DEFAULT 0,
        required_percentage REAL DEFAULT 75,
        UNIQUE(user_id, subject_name)
    )
    """)

    cur.execute("""
    CREATE TABLE IF NOT EXISTS timetable (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        day_name TEXT NOT NULL,
        period_no INTEGER NOT NULL,
        subject_name TEXT DEFAULT '',
        UNIQUE(user_id, day_name, period_no)
    )
    """)

    cur.execute("""
    CREATE TABLE IF NOT EXISTS attendance_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        log_date TEXT NOT NULL,
        period_no INTEGER NOT NULL,
        subject_name TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('present', 'absent')),
        UNIQUE(user_id, log_date, period_no)
    )
    """)

    conn.commit()

    cur.execute("PRAGMA table_info(users)")
    columns = [row[1] for row in cur.fetchall()]
    if "email" not in columns:
        cur.execute("ALTER TABLE users ADD COLUMN email TEXT")
        conn.commit()

    cur.execute("SELECT id FROM users WHERE email = ?", ("demo@mlrit.ac.in",))
    if cur.fetchone() is None:
        cur.execute("""
        INSERT INTO users (email, name, college, branch, semester, section, default_target)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (
            "demo@mlrit.ac.in",
            "Manoj",
            "MLR Institute of Technology",
            "CSE",
            "II-II",
            "A",
            75,
        ))
        conn.commit()

    conn.close()


init_db()


class UserProfile(BaseModel):
    name: str
    college: str
    branch: str
    semester: str
    section: str
    default_target: float


class AuthUserIn(BaseModel):
    email: str
    name: str


class SubjectIn(BaseModel):
    subject_name: str
    attended_classes: int
    total_classes: int
    required_percentage: float


class TimetableEntry(BaseModel):
    day_name: str
    period_no: int
    subject_name: str


class PlanRequest(BaseModel):
    mode: str
    n_days: Optional[int] = 3
    selected_days: Optional[List[str]] = None
    weeks: Optional[int] = 1


class AttendanceMarkIn(BaseModel):
    subject_name: str
    period_no: int
    status: str  # "present" or "absent"


def calculate_percentage(attended: int, total: int) -> float:
    if total <= 0:
        return 0.0
    return round((attended / total) * 100, 2)


def average_of_subject_percentages(subjects: list[sqlite3.Row]) -> float:
    if not subjects:
        return 0.0
    percentages = [
        calculate_percentage(row["attended_classes"], row["total_classes"])
        for row in subjects
    ]
    return round(sum(percentages) / len(percentages), 2)


def classes_needed(attended: int, total: int, required_percentage: float) -> int:
    required = required_percentage / 100
    if required <= 0 or required >= 1:
        return 0
    if total > 0 and calculate_percentage(attended, total) >= required_percentage:
        return 0
    x = ((required * total) - attended) / (1 - required)
    return max(0, math.ceil(x))


def safe_bunks(attended: int, total: int, required_percentage: float) -> int:
    if total == 0:
        return 0
    if calculate_percentage(attended, total) < required_percentage:
        return 0
    required = required_percentage / 100
    x = (attended / required) - total
    return max(0, math.floor(x))


def risk_label(attended: int, total: int, required_percentage: float) -> str:
    pct = calculate_percentage(attended, total)
    diff = pct - required_percentage
    if diff >= 5:
        return "Safe"
    elif diff >= 0:
        return "Warning"
    return "Danger"


def get_next_class_days(n: int):
    results = []
    today = datetime.date.today()
    offset = 1
    while len(results) < n:
        d = today + datetime.timedelta(days=offset)
        if d.strftime("%A") in DAYS:
            results.append(d)
        offset += 1
    return results


def get_subjects_for_user(user_id: int):
    conn = get_conn()
    cur = conn.cursor()
    cur.execute("""
        SELECT id, subject_name, attended_classes, total_classes, required_percentage
        FROM subjects
        WHERE user_id = ?
        ORDER BY subject_name
    """, (user_id,))
    rows = cur.fetchall()
    conn.close()
    return rows


def get_timetable_for_user(user_id: int):
    conn = get_conn()
    cur = conn.cursor()
    cur.execute("""
        SELECT day_name, period_no, subject_name
        FROM timetable
        WHERE user_id = ?
    """, (user_id,))
    rows = cur.fetchall()
    conn.close()

    data = {day: [""] * PERIODS for day in DAYS}
    for row in rows:
        day_name = row["day_name"]
        period_no = row["period_no"]
        subject_name = row["subject_name"]
        if day_name in data and 1 <= period_no <= PERIODS:
            data[day_name][period_no - 1] = subject_name or ""
    return data


def absence_counts_from_dates(timetable: dict, dates: list[datetime.date]):
    counts = Counter()
    for d in dates:
        day = d.strftime("%A")
        for sub in timetable.get(day, []):
            cleaned = (sub or "").strip()
            if cleaned:
                counts[cleaned] += 1
    return counts


def absence_counts_from_weekdays(timetable: dict, selected_days: list[str], weeks: int):
    counts = Counter()
    for _ in range(weeks):
        for day in selected_days:
            for sub in timetable.get(day, []):
                cleaned = (sub or "").strip()
                if cleaned:
                    counts[cleaned] += 1
    return counts


def simulate_future_absence(subjects, counts: Counter):
    new_percentages = []

    for row in subjects:
        subject_name = row["subject_name"]
        attended = row["attended_classes"]
        total = row["total_classes"]
        missed = counts.get(subject_name, 0)
        new_total = total + missed
        new_pct = calculate_percentage(attended, new_total)
        new_percentages.append(new_pct)

    new_avg = round(sum(new_percentages) / len(new_percentages), 2) if new_percentages else 0.0
    return new_avg


@app.get("/")
def root():
    return {"message": "BunkMax API running"}


@app.post("/auth/google-user")
def auth_google_user(payload: AuthUserIn):
    if not payload.email.endswith("@mlrit.ac.in"):
        raise HTTPException(status_code=403, detail="Only @mlrit.ac.in accounts are allowed")

    conn = get_conn()
    cur = conn.cursor()

    cur.execute("""
        SELECT id, email, name, college, branch, semester, section, default_target
        FROM users
        WHERE email = ?
    """, (payload.email,))
    row = cur.fetchone()

    if row:
        conn.close()
        return dict(row)

    cur.execute("""
        INSERT INTO users (email, name, college, branch, semester, section, default_target)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    """, (
        payload.email,
        payload.name or "Student",
        "MLR Institute of Technology",
        "",
        "",
        "",
        75,
    ))
    conn.commit()

    cur.execute("""
        SELECT id, email, name, college, branch, semester, section, default_target
        FROM users
        WHERE email = ?
    """, (payload.email,))
    new_row = cur.fetchone()
    conn.close()

    return dict(new_row)


@app.get("/users/{user_id}")
def get_user(user_id: int):
    conn = get_conn()
    cur = conn.cursor()
    cur.execute("""
        SELECT id, email, name, college, branch, semester, section, default_target
        FROM users
        WHERE id = ?
    """, (user_id,))
    row = cur.fetchone()
    conn.close()

    if not row:
        raise HTTPException(status_code=404, detail="User not found")

    return dict(row)


@app.put("/users/{user_id}")
def update_user(user_id: int, payload: UserProfile):
    conn = get_conn()
    cur = conn.cursor()
    cur.execute("""
        UPDATE users
        SET name = ?, college = ?, branch = ?, semester = ?, section = ?, default_target = ?
        WHERE id = ?
    """, (
        payload.name,
        payload.college,
        payload.branch,
        payload.semester,
        payload.section,
        payload.default_target,
        user_id,
    ))
    conn.commit()
    conn.close()
    return {"message": "Profile updated"}


@app.get("/users/{user_id}/subjects")
def list_subjects(user_id: int):
    rows = get_subjects_for_user(user_id)
    result = []
    for row in rows:
        result.append({
            "id": row["id"],
            "subject_name": row["subject_name"],
            "attended_classes": row["attended_classes"],
            "total_classes": row["total_classes"],
            "required_percentage": row["required_percentage"],
            "attendance_percentage": calculate_percentage(
                row["attended_classes"], row["total_classes"]
            ),
            "safe_bunks": safe_bunks(
                row["attended_classes"], row["total_classes"], row["required_percentage"]
            ),
            "need_to_recover": classes_needed(
                row["attended_classes"], row["total_classes"], row["required_percentage"]
            ),
            "status": risk_label(
                row["attended_classes"], row["total_classes"], row["required_percentage"]
            ),
        })
    return result


@app.post("/users/{user_id}/subjects")
def save_subject(user_id: int, payload: SubjectIn):
    if payload.attended_classes > payload.total_classes:
        raise HTTPException(status_code=400, detail="Present cannot be greater than total")

    conn = get_conn()
    cur = conn.cursor()
    cur.execute("""
        INSERT INTO subjects (user_id, subject_name, attended_classes, total_classes, required_percentage)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(user_id, subject_name)
        DO UPDATE SET
            attended_classes = excluded.attended_classes,
            total_classes = excluded.total_classes,
            required_percentage = excluded.required_percentage
    """, (
        user_id,
        payload.subject_name,
        payload.attended_classes,
        payload.total_classes,
        payload.required_percentage,
    ))
    conn.commit()
    conn.close()
    return {"message": "Subject saved"}


@app.delete("/users/{user_id}/subjects/{subject_name}")
def delete_subject(user_id: int, subject_name: str):
    conn = get_conn()
    cur = conn.cursor()
    cur.execute("""
        DELETE FROM subjects
        WHERE user_id = ? AND subject_name = ?
    """, (user_id, subject_name))
    conn.commit()
    conn.close()
    return {"message": "Subject deleted"}


@app.get("/users/{user_id}/timetable")
def get_timetable(user_id: int):
    return get_timetable_for_user(user_id)


@app.post("/users/{user_id}/timetable")
def save_timetable(user_id: int, entries: List[TimetableEntry]):
    conn = get_conn()
    cur = conn.cursor()

    for entry in entries:
        cur.execute("""
            INSERT INTO timetable (user_id, day_name, period_no, subject_name)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(user_id, day_name, period_no)
            DO UPDATE SET subject_name = excluded.subject_name
        """, (
            user_id,
            entry.day_name,
            entry.period_no,
            entry.subject_name,
        ))

    conn.commit()
    conn.close()
    return {"message": "Timetable saved"}


@app.get("/users/{user_id}/dashboard")
def dashboard(user_id: int):
    subjects = get_subjects_for_user(user_id)
    timetable = get_timetable_for_user(user_id)

    current_avg = average_of_subject_percentages(subjects)
    total_present = sum(row["attended_classes"] for row in subjects)
    total_classes = sum(row["total_classes"] for row in subjects)
    overall_percentage = round((total_present / total_classes) * 100, 2) if total_classes > 0 else 0.0

    today_name = datetime.date.today().strftime("%A")
    today_date = str(datetime.date.today())

    conn = get_conn()
    cur = conn.cursor()
    cur.execute("""
        SELECT period_no, status
        FROM attendance_logs
        WHERE user_id = ? AND log_date = ?
    """, (user_id, today_date))
    logs = {row["period_no"]: row["status"] for row in cur.fetchall()}
    conn.close()

    today_classes = []
    for i, sub in enumerate(timetable.get(today_name, [""] * PERIODS), start=1):
        today_classes.append({
            "period_no": i,
            "subject_name": sub or "",
            "marked_status": logs.get(i)
        })

    return {
        "current_avg": current_avg,
        "overall_percentage": overall_percentage,
        "total_present": total_present,
        "total_absent": total_classes - total_present,
        "today_classes": today_classes,
    }


@app.post("/users/{user_id}/mark-attendance")
def mark_attendance(user_id: int, payload: AttendanceMarkIn):
    if payload.status not in ["present", "absent"]:
        raise HTTPException(status_code=400, detail="Invalid status")

    today = str(datetime.date.today())

    conn = get_conn()
    try:
        cur = conn.cursor()
        cur.execute("BEGIN IMMEDIATE")

        cur.execute("""
            SELECT attended_classes, total_classes
            FROM subjects
            WHERE user_id = ? AND subject_name = ?
        """, (user_id, payload.subject_name))
        subject = cur.fetchone()

        if not subject:
            raise HTTPException(status_code=404, detail="Subject not found")

        cur.execute("""
            SELECT id, status
            FROM attendance_logs
            WHERE user_id = ? AND log_date = ? AND period_no = ?
        """, (user_id, today, payload.period_no))
        existing = cur.fetchone()

        attended = subject["attended_classes"]
        total = subject["total_classes"]

        if existing:
            old_status = existing["status"]

            # same click = unmark
            if old_status == payload.status:
                if old_status == "present":
                    attended = max(0, attended - 1)
                    total = max(0, total - 1)
                else:
                    total = max(0, total - 1)

                cur.execute(
                    "DELETE FROM attendance_logs WHERE id = ?",
                    (existing["id"],)
                )

                cur.execute("""
                    UPDATE subjects
                    SET attended_classes = ?, total_classes = ?
                    WHERE user_id = ? AND subject_name = ?
                """, (attended, total, user_id, payload.subject_name))

                conn.commit()
                return {"message": "Unmarked", "status": None}

            # switch absent -> present
            if old_status == "absent" and payload.status == "present":
                attended += 1

            # switch present -> absent
            elif old_status == "present" and payload.status == "absent":
                attended = max(0, attended - 1)

            cur.execute("""
                UPDATE attendance_logs
                SET status = ?, subject_name = ?
                WHERE id = ?
            """, (payload.status, payload.subject_name, existing["id"]))

        else:
            # first mark
            if payload.status == "present":
                attended += 1
                total += 1
            else:
                total += 1

            cur.execute("""
                INSERT INTO attendance_logs (user_id, log_date, period_no, subject_name, status)
                VALUES (?, ?, ?, ?, ?)
            """, (user_id, today, payload.period_no, payload.subject_name, payload.status))

        cur.execute("""
            UPDATE subjects
            SET attended_classes = ?, total_classes = ?
            WHERE user_id = ? AND subject_name = ?
        """, (attended, total, user_id, payload.subject_name))

        conn.commit()
        return {"message": "Attendance marked", "status": payload.status}

    except sqlite3.OperationalError as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")

    finally:
        conn.close()


@app.get("/users/{user_id}/quick-actions/tomorrow")
def quick_action_tomorrow(user_id: int):
    subjects = get_subjects_for_user(user_id)
    timetable = get_timetable_for_user(user_id)
    current_avg = average_of_subject_percentages(subjects)

    tomorrow = get_next_class_days(1)[0]
    counts = absence_counts_from_dates(timetable, [tomorrow])
    predicted_avg = simulate_future_absence(subjects, counts)

    return {
        "title": f"{tomorrow.strftime('%A')} ({tomorrow})",
        "current": current_avg,
        "new": predicted_avg,
        "drop": round(current_avg - predicted_avg, 2),
        "safe": predicted_avg >= 75,
    }


@app.get("/users/{user_id}/quick-actions/best-day")
def quick_action_best_day(user_id: int):
    subjects = get_subjects_for_user(user_id)
    timetable = get_timetable_for_user(user_id)
    current_avg = average_of_subject_percentages(subjects)

    upcoming_days = get_next_class_days(6)
    evaluations = []
    for d in upcoming_days:
        counts = absence_counts_from_dates(timetable, [d])
        predicted_avg = simulate_future_absence(subjects, counts)
        evaluations.append((d, predicted_avg, current_avg - predicted_avg))

    best = min(evaluations, key=lambda x: x[2])

    return {
        "title": f"{best[0].strftime('%A')} ({best[0]})",
        "current": current_avg,
        "new": best[1],
        "drop": round(best[2], 2),
        "safe": best[1] >= 75,
    }


@app.get("/users/{user_id}/quick-actions/worst-day")
def quick_action_worst_day(user_id: int):
    subjects = get_subjects_for_user(user_id)
    timetable = get_timetable_for_user(user_id)
    current_avg = average_of_subject_percentages(subjects)

    upcoming_days = get_next_class_days(6)
    evaluations = []
    for d in upcoming_days:
        counts = absence_counts_from_dates(timetable, [d])
        predicted_avg = simulate_future_absence(subjects, counts)
        evaluations.append((d, predicted_avg, current_avg - predicted_avg))

    worst = max(evaluations, key=lambda x: x[2])

    return {
        "title": f"{worst[0].strftime('%A')} ({worst[0]})",
        "current": current_avg,
        "new": worst[1],
        "drop": round(worst[2], 2),
        "safe": worst[1] >= 75,
    }


@app.post("/users/{user_id}/plan")
def plan_bunks(user_id: int, payload: PlanRequest):
    subjects = get_subjects_for_user(user_id)
    timetable = get_timetable_for_user(user_id)
    current_avg = average_of_subject_percentages(subjects)

    counts = Counter()
    scenario_label = ""

    if payload.mode == "tomorrow":
        tomorrow = get_next_class_days(1)[0]
        counts = absence_counts_from_dates(timetable, [tomorrow])
        scenario_label = f"If you are absent on {tomorrow.strftime('%A')} ({tomorrow})"

    elif payload.mode == "next_n_days":
        n = payload.n_days or 3
        dates = get_next_class_days(n)
        counts = absence_counts_from_dates(timetable, dates)
        scenario_label = f"If you are absent for the next {n} class days"

    elif payload.mode == "selected_weekdays":
        selected_days = payload.selected_days or ["Monday"]
        weeks = payload.weeks or 1
        counts = absence_counts_from_weekdays(timetable, selected_days, weeks)
        scenario_label = f"If you are absent on {', '.join(selected_days)} for {weeks} week(s)"

    else:
        raise HTTPException(status_code=400, detail="Invalid mode")

    predicted_avg = simulate_future_absence(subjects, counts)

    return {
        "scenario_label": scenario_label,
        "current_avg": current_avg,
        "predicted_avg": predicted_avg,
        "drop": round(current_avg - predicted_avg, 2),
    }