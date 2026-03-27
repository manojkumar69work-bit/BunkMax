import math
import sqlite3
import datetime
from collections import Counter
from urllib.parse import quote

import streamlit as st

# =========================================================
# PAGE CONFIG
# =========================================================
st.set_page_config(
    page_title="BunkMax",
    page_icon="📘",
    layout="centered"
)

# =========================================================
# STYLES
# =========================================================
st.markdown("""
<style>
.block-container {
    max-width: 430px;
    padding-top: 0.95rem;
    padding-bottom: 8.2rem;
}

html, body, [class*="css"] {
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 14px;
}

/* Header */
.main-title {
    font-size: 1.18rem;
    font-weight: 800;
    line-height: 1.15;
    margin: 0;
    letter-spacing: -0.02em;
}

.sub-title {
    color: #A9AFB8;
    font-size: 0.80rem;
    margin-top: 0.14rem;
    margin-bottom: 0.72rem;
    line-height: 1.3;
}

.page-pill {
    display: inline-block;
    padding: 5px 11px;
    border-radius: 999px;
    background: rgba(255,255,255,0.05);
    border: 1px solid rgba(255,255,255,0.08);
    font-size: 0.68rem;
    font-weight: 700;
    margin-bottom: 0.85rem;
}

.section-title {
    font-size: 0.98rem;
    font-weight: 800;
    margin-top: 0.15rem;
    margin-bottom: 0.60rem;
}

/* Cards */
.card {
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 18px;
    padding: 12px;
    margin-bottom: 10px;
    background: rgba(255,255,255,0.03);
    box-shadow: 0 8px 24px rgba(0,0,0,0.10);
}

.premium-card {
    border: 1px solid rgba(255,255,255,0.10);
    border-radius: 18px;
    padding: 12px;
    margin-bottom: 10px;
    background:
        linear-gradient(135deg, rgba(131,58,180,0.12), rgba(253,29,29,0.08), rgba(252,176,69,0.10));
    box-shadow: 0 10px 28px rgba(0,0,0,0.12);
}

.card-title {
    font-size: 0.92rem;
    font-weight: 700;
    margin-bottom: 0.25rem;
}

.small-muted {
    color: #9AA0A6;
    font-size: 0.78rem;
}

.small-text {
    font-size: 0.86rem;
}

.quick-title {
    font-size: 0.92rem;
    font-weight: 700;
    margin-bottom: 0.18rem;
}

.quick-sub {
    color: #B8BCC6;
    font-size: 0.76rem;
    margin-bottom: 0.55rem;
}

/* Widgets */
.stButton > button {
    width: 100%;
    min-height: 42px;
    border-radius: 13px;
    font-size: 13.5px;
    font-weight: 700;
}

div[data-testid="stForm"] {
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 18px;
    padding: 12px;
    background: rgba(255,255,255,0.03);
}

[data-testid="stMetric"] {
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 16px;
    padding: 6px;
    background: rgba(255,255,255,0.03);
}

label, .stTextInput label, .stNumberInput label, .stSelectbox label, .stMultiSelect label {
    font-size: 0.82rem !important;
}

div[data-testid="stMetricLabel"] {
    font-size: 0.75rem !important;
}

div[data-testid="stMetricValue"] {
    font-size: 1.95rem !important;
}

/* Fixed bottom nav */
.bottom-nav-shell {
    position: fixed;
    left: 50%;
    bottom: 10px;
    transform: translateX(-50%);
    width: min(410px, calc(100vw - 18px));
    z-index: 99999;
    background: rgba(7,10,16,0.97);
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 24px;
    padding: 8px 10px 7px 10px;
    box-shadow: 0 14px 36px rgba(0,0,0,0.30);
    backdrop-filter: blur(14px);
}

.bottom-nav-grid {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 2px;
    align-items: end;
}

.nav-item {
    text-decoration: none;
    color: #B8BCC6;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 6px 2px 4px 2px;
    border-radius: 16px;
    min-height: 50px;
    transition: transform 0.15s ease, color 0.15s ease;
}

.nav-item:hover {
    transform: translateY(-1px);
}

.nav-item.active {
    color: white;
}

.nav-icon {
    font-size: 1.34rem;
    line-height: 1;
}

.nav-label {
    text-align: center;
    font-size: 0.60rem;
    margin-top: 3px;
    min-height: 13px;
    line-height: 1.05;
    font-weight: 700;
}

.top-spacer {
    height: 6px;
}

hr {
    margin-top: 0.7rem;
    margin-bottom: 0.7rem;
}
</style>
""", unsafe_allow_html=True)

# =========================================================
# CONSTANTS
# =========================================================
ALLOWED_DOMAIN = "@mlrit.ac.in"
DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
PERIODS = 6
PERIOD_TIMES = {
    1: "9:20 - 10:20",
    2: "10:20 - 11:20",
    3: "11:20 - 12:20",
    4: "1:10 - 2:10",
    5: "2:10 - 3:10",
    6: "3:10 - 4:10",
}

# =========================================================
# LOGIN HELPERS
# =========================================================
def get_logged_in_email():
    try:
        return str(st.user.get("email", "")).strip().lower()
    except Exception:
        return ""

def get_logged_in_name():
    try:
        return str(st.user.get("name", "")).strip()
    except Exception:
        return ""

# =========================================================
# LOGIN
# =========================================================
if not st.user.is_logged_in:
    st.markdown('<div class="top-spacer"></div>', unsafe_allow_html=True)
    st.markdown('<div class="main-title">📘 BunkMax</div>', unsafe_allow_html=True)
    st.markdown('<div class="sub-title">Premium attendance planner for students</div>', unsafe_allow_html=True)
    st.info("Continue with your college Google account")
    if st.button("Continue with Google"):
        st.login("google")
    st.stop()

logged_in_email = get_logged_in_email()
logged_in_name = get_logged_in_name()

if not logged_in_email.endswith(ALLOWED_DOMAIN):
    st.error("Only MLRIT college accounts are allowed.")
    if st.button("Logout"):
        st.logout()
    st.stop()

# =========================================================
# DATABASE
# =========================================================
conn = sqlite3.connect("attendance.db", check_same_thread=False)
cursor = conn.cursor()

cursor.execute("""
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    name TEXT
)
""")

cursor.execute("""
CREATE TABLE IF NOT EXISTS subjects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    subject_name TEXT,
    attended_classes INTEGER DEFAULT 0,
    total_classes INTEGER DEFAULT 0,
    required_percentage REAL DEFAULT 75
)
""")

cursor.execute("""
CREATE TABLE IF NOT EXISTS timetable (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    day_name TEXT,
    period_no INTEGER,
    subject_name TEXT
)
""")
conn.commit()

def ensure_column(table_name: str, column_name: str, definition: str):
    cursor.execute(f"PRAGMA table_info({table_name})")
    existing = [row[1] for row in cursor.fetchall()]
    if column_name not in existing:
        cursor.execute(f"ALTER TABLE {table_name} ADD COLUMN {column_name} {definition}")
        conn.commit()

ensure_column("users", "college", "TEXT")
ensure_column("users", "branch", "TEXT")
ensure_column("users", "semester", "TEXT")
ensure_column("users", "section", "TEXT")
ensure_column("users", "default_target", "REAL DEFAULT 75")

ensure_column("subjects", "subject_name", "TEXT")
ensure_column("subjects", "attended_classes", "INTEGER DEFAULT 0")
ensure_column("subjects", "total_classes", "INTEGER DEFAULT 0")
ensure_column("subjects", "required_percentage", "REAL DEFAULT 75")

ensure_column("timetable", "day_name", "TEXT")
ensure_column("timetable", "period_no", "INTEGER")
ensure_column("timetable", "subject_name", "TEXT")

cursor.execute("""
CREATE UNIQUE INDEX IF NOT EXISTS idx_subjects_user_subject
ON subjects(user_id, subject_name)
""")

cursor.execute("""
CREATE UNIQUE INDEX IF NOT EXISTS idx_timetable_user_day_period
ON timetable(user_id, day_name, period_no)
""")
conn.commit()

# =========================================================
# DB HELPERS
# =========================================================
def ensure_user(email: str, name: str):
    cursor.execute("SELECT id FROM users WHERE email = ?", (email,))
    row = cursor.fetchone()
    if row:
        return row[0]

    cursor.execute("""
        INSERT INTO users (email, name, college, branch, semester, section, default_target)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    """, (
        email,
        name or "Student",
        "MLR Institute of Technology",
        "CSE",
        "II-II",
        "A",
        75.0
    ))
    conn.commit()
    cursor.execute("SELECT id FROM users WHERE email = ?", (email,))
    return cursor.fetchone()[0]

def get_user(user_id: int):
    cursor.execute("""
        SELECT id, email, name, college, branch, semester, section, default_target
        FROM users
        WHERE id = ?
    """, (user_id,))
    return cursor.fetchone()

def update_user(user_id: int, name: str, college: str, branch: str, semester: str, section: str, default_target: float):
    cursor.execute("""
        UPDATE users
        SET name = ?, college = ?, branch = ?, semester = ?, section = ?, default_target = ?
        WHERE id = ?
    """, (name, college, branch, semester, section, default_target, user_id))
    conn.commit()

def get_subjects(user_id: int):
    cursor.execute("""
        SELECT id, subject_name, attended_classes, total_classes, required_percentage
        FROM subjects
        WHERE user_id = ?
        ORDER BY subject_name
    """, (user_id,))
    return cursor.fetchall()

def add_or_update_subject(user_id: int, subject_name: str, attended_classes: int, total_classes: int, required_percentage: float):
    cursor.execute("""
        INSERT INTO subjects (user_id, subject_name, attended_classes, total_classes, required_percentage)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(user_id, subject_name)
        DO UPDATE SET
            attended_classes = excluded.attended_classes,
            total_classes = excluded.total_classes,
            required_percentage = excluded.required_percentage
    """, (user_id, subject_name, attended_classes, total_classes, required_percentage))
    conn.commit()

def delete_subject(user_id: int, subject_name: str):
    cursor.execute("""
        DELETE FROM subjects
        WHERE user_id = ? AND subject_name = ?
    """, (user_id, subject_name))
    conn.commit()

def clear_subjects(user_id: int):
    cursor.execute("DELETE FROM subjects WHERE user_id = ?", (user_id,))
    conn.commit()

def get_timetable(user_id: int):
    cursor.execute("""
        SELECT day_name, period_no, subject_name
        FROM timetable
        WHERE user_id = ?
    """, (user_id,))
    rows = cursor.fetchall()
    data = {day: [""] * PERIODS for day in DAYS}
    for day_name, period_no, subject_name in rows:
        if day_name in data and 1 <= period_no <= PERIODS:
            data[day_name][period_no - 1] = subject_name or ""
    return data

def save_timetable_entry(user_id: int, day_name: str, period_no: int, subject_name: str):
    cursor.execute("""
        INSERT INTO timetable (user_id, day_name, period_no, subject_name)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id, day_name, period_no)
        DO UPDATE SET subject_name = excluded.subject_name
    """, (user_id, day_name, period_no, subject_name))
    conn.commit()

def clear_timetable(user_id: int):
    cursor.execute("DELETE FROM timetable WHERE user_id = ?", (user_id,))
    conn.commit()

# =========================================================
# CALC HELPERS
# =========================================================
def calculate_percentage(attended: int, total: int) -> float:
    if total <= 0:
        return 0.0
    return (attended / total) * 100

def average_of_subject_percentages(subjects) -> float:
    if not subjects:
        return 0.0
    percentages = [calculate_percentage(attended, total) for _, _, attended, total, _ in subjects]
    return sum(percentages) / len(percentages)

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
        return "🟢 Safe"
    elif diff >= 0:
        return "🟡 Warning"
    return "🔴 Danger"

# =========================================================
# FORECAST HELPERS
# =========================================================
def get_next_class_days(n: int):
    result = []
    current = datetime.date.today()
    offset = 1
    while len(result) < n:
        d = current + datetime.timedelta(days=offset)
        if d.strftime("%A") in DAYS:
            result.append(d)
        offset += 1
    return result

def absence_counts_from_dates(timetable: dict, dates: list):
    counts = Counter()
    for d in dates:
        day = d.strftime("%A")
        for sub in timetable.get(day, []):
            cleaned = (sub or "").strip()
            if cleaned:
                counts[cleaned] += 1
    return counts

def absence_counts_from_weekdays(timetable: dict, selected_days: list, weeks: int):
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
    for _, subject_name, attended, total, req in subjects:
        missed = counts.get(subject_name, 0)
        new_total = total + missed
        new_pct = calculate_percentage(attended, new_total)
        new_percentages.append(new_pct)
    new_avg = sum(new_percentages) / len(new_percentages) if new_percentages else 0.0
    return new_avg

# =========================================================
# USER INIT
# =========================================================
user_id = ensure_user(logged_in_email, logged_in_name)
user = get_user(user_id)
_, email, name, college, branch, semester, section, default_target = user

# =========================================================
# STATE
# =========================================================
nav_items = [
    ("My Subjects", "📚"),
    ("My Schedule", "🗓"),
    ("Home", "🏠"),
    ("Plan My Bunks", "⚡"),
    ("Profile", "👤"),
]

query_nav = st.query_params.get("nav")
if isinstance(query_nav, list):
    query_nav = query_nav[0]

valid_pages = [label for label, _ in nav_items]

if "page" not in st.session_state:
    st.session_state.page = "Home"

if query_nav in valid_pages and query_nav != st.session_state.page:
    st.session_state.page = query_nav
    st.query_params.clear()

if "quick_result" not in st.session_state:
    st.session_state.quick_result = None

# =========================================================
# LOAD DATA
# =========================================================
subjects = get_subjects(user_id)
timetable = get_timetable(user_id)
has_timetable = any(any((cell or "").strip() for cell in timetable.get(day, [])) for day in DAYS)

# =========================================================
# HEADER
# =========================================================
header_left, header_right = st.columns([5, 1])

with header_left:
    st.markdown('<div class="main-title">📘 BunkMax</div>', unsafe_allow_html=True)
    st.markdown(f'<div class="sub-title">Hey {name} • Smart attendance planner</div>', unsafe_allow_html=True)

with header_right:
    with st.popover("⚙️", use_container_width=True):
        st.write(f"**{email}**")
        if st.button("Logout", use_container_width=True, key="logout_main"):
            st.logout()

st.markdown(f'<div class="page-pill">{st.session_state.page}</div>', unsafe_allow_html=True)

# =========================================================
# NAVIGATION BUTTONS
# =========================================================
nav_row_1 = st.columns(3)
if nav_row_1[0].button("🏠 Home", use_container_width=True):
    st.session_state.page = "Home"
    st.rerun()
if nav_row_1[1].button("⚡ Plan My Bunks", use_container_width=True):
    st.session_state.page = "Plan My Bunks"
    st.rerun()
if nav_row_1[2].button("🗓 My Schedule", use_container_width=True):
    st.session_state.page = "My Schedule"
    st.rerun()

nav_row_2 = st.columns(2)
if nav_row_2[0].button("📚 My Subjects", use_container_width=True):
    st.session_state.page = "My Subjects"
    st.rerun()
if nav_row_2[1].button("👤 Profile", use_container_width=True):
    st.session_state.page = "Profile"
    st.rerun()

st.markdown("---")
# =========================================================
# HOME
# =========================================================
if st.session_state.page == "Home":
    if subjects:
        current_avg = average_of_subject_percentages(subjects)
        total_present = sum(s[2] for s in subjects)
        total_classes = sum(s[3] for s in subjects)
        overall_percentage = (total_present / total_classes * 100) if total_classes > 0 else 0

        row1 = st.columns(2)
        row2 = st.columns(2)
        row1[0].metric("Average", f"{current_avg:.1f}%")
        row1[1].metric("Overall", f"{overall_percentage:.1f}%")
        row2[0].metric("Present", total_present)
        row2[1].metric("Absent", total_classes - total_present)

        if overall_percentage >= 75:
            st.success("You are above 75% ✅")
        elif overall_percentage >= 65:
            st.warning("You are getting close to shortage ⚠️")
        else:
            st.error("Your attendance is low 🚨")

        st.markdown('<div class="section-title">Quick Actions</div>', unsafe_allow_html=True)

        st.markdown('<div class="premium-card"><div class="quick-title">Should I skip tomorrow?</div><div class="quick-sub">Instant answer for the next class day.</div></div>', unsafe_allow_html=True)
        if st.button("Check Tomorrow"):
            tomorrow = get_next_class_days(1)[0]
            counts = absence_counts_from_dates(timetable, [tomorrow])
            predicted_avg = simulate_future_absence(subjects, counts)
            st.session_state.quick_result = {
                "title": f"{tomorrow.strftime('%A')} ({tomorrow})",
                "new": predicted_avg,
                "drop": current_avg - predicted_avg,
                "kind": "success" if predicted_avg >= 75 else "warning",
                "message": "✅ Safe to skip" if predicted_avg >= 75 else "⚠️ Not safe to skip",
            }

        st.markdown('<div class="premium-card"><div class="quick-title">Best day to skip</div><div class="quick-sub">Find the safest upcoming day.</div></div>', unsafe_allow_html=True)
        if st.button("Find Best Day"):
            upcoming_days = get_next_class_days(6)
            evaluations = []
            for d in upcoming_days:
                counts = absence_counts_from_dates(timetable, [d])
                predicted_avg = simulate_future_absence(subjects, counts)
                evaluations.append((d, predicted_avg, current_avg - predicted_avg))
            best = min(evaluations, key=lambda x: x[2])
            st.session_state.quick_result = {
                "title": f"{best[0].strftime('%A')} ({best[0]})",
                "new": best[1],
                "drop": best[2],
                "kind": "success" if best[1] >= 75 else "warning",
                "message": "✅ Safest day to skip" if best[1] >= 75 else "⚠️ Still risky",
            }

        st.markdown('<div class="premium-card"><div class="quick-title">Avoid skipping on</div><div class="quick-sub">Know the worst upcoming day to miss.</div></div>', unsafe_allow_html=True)
        if st.button("Find Worst Day"):
            upcoming_days = get_next_class_days(6)
            evaluations = []
            for d in upcoming_days:
                counts = absence_counts_from_dates(timetable, [d])
                predicted_avg = simulate_future_absence(subjects, counts)
                evaluations.append((d, predicted_avg, current_avg - predicted_avg))
            worst = max(evaluations, key=lambda x: x[2])
            st.session_state.quick_result = {
                "title": f"{worst[0].strftime('%A')} ({worst[0]})",
                "new": worst[1],
                "drop": worst[2],
                "kind": "error",
                "message": "❌ Avoid skipping on this day",
            }

        result = st.session_state.quick_result
        if result:
            st.markdown('<div class="card">', unsafe_allow_html=True)
            if result["kind"] == "success":
                st.success(result["title"])
            elif result["kind"] == "warning":
                st.warning(result["title"])
            else:
                st.error(result["title"])

            rr = st.columns(3)
            rr[0].metric("Current", f"{current_avg:.1f}%")
            rr[1].metric("New", f"{result['new']:.1f}%")
            rr[2].metric("Drop", f"{result['drop']:.1f}%")

            if result["kind"] == "success":
                st.success(result["message"])
            elif result["kind"] == "warning":
                st.warning(result["message"])
            else:
                st.error(result["message"])
            st.markdown('</div>', unsafe_allow_html=True)

        st.markdown('<div class="section-title">Today\'s Classes</div>', unsafe_allow_html=True)
        today_name = datetime.date.today().strftime("%A")
        today_subjects = timetable.get(today_name, [""] * PERIODS)

        for i, sub in enumerate(today_subjects, start=1):
            st.markdown(
                f"""
                <div class="card">
                    <div class="card-title">Period {i}</div>
                    <div class="small-muted">{PERIOD_TIMES[i]}</div>
                    <div class="small-text" style="margin-top:8px;font-weight:600;">{sub or '---'}</div>
                </div>
                """,
                unsafe_allow_html=True
            )
    else:
        st.info("Add your subjects first.")

# =========================================================
# PLAN MY BUNKS
# =========================================================
elif st.session_state.page == "Plan My Bunks":
    st.markdown('<div class="section-title">Plan My Bunks</div>', unsafe_allow_html=True)

    if subjects and has_timetable:
        mode = st.selectbox(
            "Choose a scenario",
            ["Absent tomorrow", "Absent for next N class days", "Absent on selected weekdays"]
        )

        counts = Counter()
        scenario_label = ""

        if mode == "Absent tomorrow":
            tomorrow = get_next_class_days(1)[0]
            counts = absence_counts_from_dates(timetable, [tomorrow])
            scenario_label = f"If you are absent on {tomorrow.strftime('%A')} ({tomorrow})"

        elif mode == "Absent for next N class days":
            n = st.number_input("How many upcoming class days?", min_value=1, max_value=30, value=3, step=1)
            dates = get_next_class_days(int(n))
            counts = absence_counts_from_dates(timetable, dates)
            scenario_label = f"If you are absent for the next {int(n)} class days"

        else:
            selected_days = st.multiselect("Select weekdays", DAYS, default=["Monday"])
            weeks = st.number_input("For how many weeks?", min_value=1, max_value=12, value=1, step=1)
            counts = absence_counts_from_weekdays(timetable, selected_days, int(weeks))
            scenario_label = f"If you are absent on {', '.join(selected_days)} for {int(weeks)} week(s)"

        st.info(scenario_label)

        if counts:
            current_avg = average_of_subject_percentages(subjects)
            predicted_avg = simulate_future_absence(subjects, counts)

            row = st.columns(3)
            row[0].metric("Current", f"{current_avg:.1f}%")
            row[1].metric("Predicted", f"{predicted_avg:.1f}%")
            row[2].metric("Drop", f"{current_avg - predicted_avg:.1f}%")
        else:
            st.info("No classes would be missed in this scenario.")
    else:
        st.info("You need both subjects and schedule first.")

# =========================================================
# MY SCHEDULE
# =========================================================
elif st.session_state.page == "My Schedule":
    st.markdown('<div class="section-title">My Schedule</div>', unsafe_allow_html=True)

    subject_names = [s[1] for s in subjects]

    if not subject_names:
        st.info("Add your subjects first.")
    else:
        with st.form("schedule_form"):
            options = [""] + subject_names

            for day in DAYS:
                st.markdown(f"#### {day}")
                current_day_values = timetable.get(day, [""] * PERIODS)

                for i in range(PERIODS):
                    current_value = current_day_values[i]
                    index = options.index(current_value) if current_value in options else 0

                    selected = st.selectbox(
                        f"Period {i + 1} • {PERIOD_TIMES[i + 1]}",
                        options=options,
                        index=index,
                        key=f"{day}_{i + 1}"
                    )
                    current_day_values[i] = selected

                timetable[day] = current_day_values
                st.markdown("---")

            save_schedule = st.form_submit_button("Save My Schedule")

            if save_schedule:
                for day in DAYS:
                    for i in range(PERIODS):
                        save_timetable_entry(user_id, day, i + 1, timetable[day][i].strip())
                st.success("My Schedule saved.")
                st.rerun()

        st.markdown('<div class="section-title">Full Schedule Preview</div>', unsafe_allow_html=True)
        for day in DAYS:
            with st.expander(day):
                for i, sub in enumerate(timetable.get(day, [""] * PERIODS), start=1):
                    st.write(f"**Period {i}** • {PERIOD_TIMES[i]} • {sub or '---'}")

# =========================================================
# MY SUBJECTS
# =========================================================
elif st.session_state.page == "My Subjects":
    st.markdown('<div class="section-title">My Subjects</div>', unsafe_allow_html=True)

    with st.form("add_subject_form"):
        subject_name = st.text_input("Subject Name")
        attended_classes = st.number_input("Present Classes", min_value=0, value=0, step=1)
        total_classes = st.number_input("Total Classes", min_value=0, value=0, step=1)
        required_percentage = st.number_input(
            "Required %",
            min_value=50.0,
            max_value=100.0,
            value=float(default_target),
            step=1.0
        )
        add_subject_btn = st.form_submit_button("Add / Update Subject")

        if add_subject_btn:
            if not subject_name.strip():
                st.error("Please enter subject name.")
            elif attended_classes > total_classes:
                st.error("Present classes cannot be greater than total classes.")
            else:
                add_or_update_subject(
                    user_id,
                    subject_name.strip(),
                    int(attended_classes),
                    int(total_classes),
                    float(required_percentage)
                )
                st.success(f"{subject_name} saved.")
                st.rerun()

    subjects = get_subjects(user_id)

    if subjects:
        for _, sub_name, attended, total, req in subjects:
            st.markdown('<div class="card">', unsafe_allow_html=True)
            st.markdown(f'<div class="card-title">{sub_name}</div>', unsafe_allow_html=True)

            m = st.columns(2)
            m[0].metric("Attendance", f"{calculate_percentage(attended, total):.1f}%")
            m[1].metric("Safe Bunks", safe_bunks(attended, total, req))

            st.write(f"Present: **{attended}**")
            st.write(f"Total: **{total}**")
            st.write(f"Required: **{req}%**")
            st.write(f"Need to Recover: **{classes_needed(attended, total, req)}**")
            st.write(f"Status: **{risk_label(attended, total, req)}**")

            with st.expander(f"Edit {sub_name}"):
                with st.form(f"edit_{sub_name}"):
                    new_attended = st.number_input("Present", min_value=0, value=int(attended), step=1, key=f"att_{sub_name}")
                    new_total = st.number_input("Total", min_value=0, value=int(total), step=1, key=f"tot_{sub_name}")
                    new_req = st.number_input("Required %", min_value=50.0, max_value=100.0, value=float(req), step=1.0, key=f"req_{sub_name}")

                    b1, b2 = st.columns(2)
                    update_btn = b1.form_submit_button("Save")
                    delete_btn = b2.form_submit_button("Delete")

                    if update_btn:
                        if new_attended > new_total:
                            st.error("Present cannot be greater than total.")
                        else:
                            add_or_update_subject(user_id, sub_name, int(new_attended), int(new_total), float(new_req))
                            st.success("Updated.")
                            st.rerun()

                    if delete_btn:
                        delete_subject(user_id, sub_name)
                        st.success("Deleted.")
                        st.rerun()

            st.markdown('</div>', unsafe_allow_html=True)
    else:
        st.info("No subjects added yet.")

# =========================================================
# PROFILE
# =========================================================
elif st.session_state.page == "Profile":
    st.markdown('<div class="section-title">Profile</div>', unsafe_allow_html=True)

    with st.form("profile_form"):
        new_name = st.text_input("Name", value=name or "")
        new_college = st.text_input("College", value=college or "MLR Institute of Technology")
        new_branch = st.text_input("Branch", value=branch or "CSE")
        new_semester = st.text_input("Semester", value=semester or "II-II")
        new_section = st.text_input("Section", value=section or "A")
        new_default_target = st.number_input(
            "Default Required Attendance %",
            min_value=50.0,
            max_value=100.0,
            value=float(default_target),
            step=1.0
        )

        save_profile = st.form_submit_button("Update Profile")
        if save_profile:
            update_user(
                user_id,
                new_name.strip(),
                new_college.strip(),
                new_branch.strip(),
                new_semester.strip(),
                new_section.strip(),
                float(new_default_target)
            )
            st.success("Profile updated.")
            st.rerun()

    st.markdown("---")
    st.markdown('<div class="section-title">Reset Data</div>', unsafe_allow_html=True)

    confirm_clear_subjects = st.checkbox("Confirm clear My Subjects")
    if st.button("Clear My Subjects"):
        if confirm_clear_subjects:
            clear_subjects(user_id)
            st.success("My Subjects cleared.")
            st.rerun()
        else:
            st.warning("Please confirm first.")

    confirm_clear_schedule = st.checkbox("Confirm clear My Schedule")
    if st.button("Clear My Schedule"):
        if confirm_clear_schedule:
            clear_timetable(user_id)
            st.success("My Schedule cleared.")
            st.rerun()
        else:
            st.warning("Please confirm first.")