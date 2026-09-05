"""
CampusHub (campushub.mlrit.ac.in) student-portal client.

CampusHub is a Next.js app backed directly by Supabase; there is no bespoke
API. Auth is Supabase email/password (email = "<rollno>@mlrit.ac.in") and
attendance lives in the world-readable `student_attendance_summary` view keyed
by the roll number.

`fetch_attendance(username, password, slug)` returns the normalized payload
`/import` consumes. `slug` is vestigial (single institute) and ignored.

The weekly timetable comes from CampusHub's own server route
`/api/student/timetable?department=&section=&year=&semester=` (Bearer token),
which already resolves subject names — the raw `timetable` table only has
subject uuids and `subjects` is RLS-locked to students. `fetch_all` does one
login and returns both attendance and timetable.
"""

import logging
from datetime import date
from typing import Any, Optional

import requests

logger = logging.getLogger("campushub")

SUPABASE_URL = "https://aikpzlzcqqwtlqfxlcer.supabase.co"
# Publishable (anon) key — safe to embed; it's shipped in the CampusHub JS bundle.
ANON_KEY = "sb_publishable_meQTqjR8P2B94H0SxjFrNA_RMLG00KJ"
CAMPUSHUB_BASE = "https://campushub.mlrit.ac.in"
EMAIL_DOMAIN = "mlrit.ac.in"
DEFAULT_SLUG = "mlrit-hyderabad"  # kept for DB-default / signature compatibility
_TIMEOUT = 30

# CampusHub `weekday` follows JS Date.getDay(): 0=Sunday .. 6=Saturday.
WEEKDAY_NAMES = {
    1: "Monday", 2: "Tuesday", 3: "Wednesday",
    4: "Thursday", 5: "Friday", 6: "Saturday", 0: "Sunday",
}
MAX_PERIOD = 6  # BunkMax's timetable table constrains period_no to 1..6
# CampusHub's per-record status vocabulary; `late` still counts as attended.
ATTENDED_STATUSES = {"present", "late"}


class ERPError(Exception):
    """A user-surfaceable ERP failure. `status` maps to an HTTP status code."""

    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.message = message
        self.status = status


def _headers(token: str = ANON_KEY) -> dict:
    return {"apikey": ANON_KEY, "Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def _login(session: requests.Session, email: str, password: str) -> str:
    """
    Sign in to CampusHub and return the bearer token its API routes expect.

    CampusHub has moved off Supabase auth onto **AWS Cognito**. The portal
    posts to its own `/api/auth/cognito-signin` route and then sends the
    **`idToken`** (not `accessToken`) as `Authorization: Bearer` on every
    `/api/student/*` call — see `authHeader()`/`getAccessToken()` in the bundle.
    """
    try:
        resp = session.post(
            f"{CAMPUSHUB_BASE}/api/auth/cognito-signin",
            headers={"Content-Type": "application/json"},
            json={"email": email, "password": password},
            timeout=_TIMEOUT,
        )
    except requests.Timeout as exc:
        raise ERPError("The college portal timed out. Please try again.", 504) from exc
    except requests.RequestException as exc:
        logger.warning("CampusHub login request failed: %s", exc)
        raise ERPError("Could not reach the college portal. Please try again later.", 502) from exc

    if resp.status_code == 200:
        body = resp.json() or {}
        # First-time / admin-reset accounts must set a password in the portal
        # before any API route will serve them.
        if body.get("challenge") == "NEW_PASSWORD_REQUIRED":
            raise ERPError(
                "CampusHub needs you to set a new password. Sign in at "
                "campushub.mlrit.ac.in once, then sync again.",
                401,
            )
        token = body.get("idToken")
        if token:
            return token
        raise ERPError("Portal login response was incomplete.", 502)

    if resp.status_code in (400, 401, 403):
        raise ERPError("Invalid ERP roll number or password.", 401)
    logger.warning("CampusHub login unexpected status %s: %s", resp.status_code, resp.text[:200])
    raise ERPError("The college portal returned an unexpected response.", 502)


def _fetch_attendance_module(session: requests.Session, token: str) -> dict:
    """
    CampusHub's own attendance module — the authoritative source.

    `GET /api/student/attendance` (Bearer idToken, no params: the route derives
    the student from the token) returns the portal's own aggregate, already
    scoped to the **current semester**:

        {"student": {...},
         "overall_stats": {attendance_percentage, classes_attended,
                           total_classes, days_needed_for_75_percent},
         "subject_wise_attendance": [{subject_name, subject_code,
                                      total_classes, classes_attended,
                                      attendance_percentage}],
         "records": [{date, subject_name, subject_code, status,
                      period_number, faculty_name}],
         "recent_attendance": [ ...same shape... ]}

    Returns {} when the route is unavailable, so callers can fall back.
    """
    try:
        resp = session.get(
            f"{CAMPUSHUB_BASE}/api/student/attendance",
            headers={"Authorization": f"Bearer {token}"},
            timeout=_TIMEOUT,
        )
    except requests.Timeout as exc:
        raise ERPError("The college portal timed out. Please try again.", 504) from exc
    except requests.RequestException as exc:
        logger.warning("CampusHub attendance module request failed: %s", exc)
        raise ERPError("Could not reach the college portal. Please try again later.", 502) from exc

    if resp.status_code == 401:
        raise ERPError("Your portal session was rejected. Please sync again.", 401)
    if resp.status_code != 200:
        logger.warning(
            "CampusHub attendance module status %s: %s", resp.status_code, resp.text[:200]
        )
        return {}
    body = resp.json()
    return body if isinstance(body, dict) else {}


def _get_rows(session: requests.Session, token: str, url: str, what: str) -> list:
    """GET a Supabase REST URL, returning the decoded list (never None)."""
    try:
        resp = session.get(url, headers=_headers(token), timeout=_TIMEOUT)
    except requests.Timeout as exc:
        raise ERPError("The college portal timed out. Please try again.", 504) from exc
    except requests.RequestException as exc:
        logger.warning("CampusHub %s request failed: %s", what, exc)
        raise ERPError("Could not reach the college portal. Please try again later.", 502) from exc

    if resp.status_code != 200:
        logger.warning("CampusHub %s status %s: %s", what, resp.status_code, resp.text[:200])
        raise ERPError("The college portal returned an unexpected response.", 502)
    body = resp.json()
    return body if isinstance(body, list) else []


def _fetch_records(session: requests.Session, token: str, roll: str) -> list[dict]:
    """
    Current CampusHub attendance model, aggregated to summary rows.

    Faculty now mark attendance per class *session*: `attendance_sessions` holds
    the session (subject, date, period, status) and `attendance_records` holds
    one present/absent row per student in it, keyed by `student_roll_number`.
    The legacy `attendance` table and its `student_attendance_summary` view are
    frozen, so we aggregate the session rows ourselves.

    Only `closed` sessions count — an `open` one is still being marked and its
    partial rows would understate the total.
    """
    url = (
        f"{SUPABASE_URL}/rest/v1/attendance_records"
        f"?student_roll_number=eq.{roll}"
        "&select=status,attendance_sessions!inner(subject_name,subject_code,status)"
        "&attendance_sessions.status=eq.closed"
    )
    return _aggregate_records(_get_rows(session, token, url, "attendance records"))


def _aggregate_records(rows: list) -> list[dict]:
    """Group per-session records by subject into `_normalize_attendance` rows."""
    # subject name -> [code, total, attended]
    agg: dict[str, list] = {}
    for r in rows:
        if not isinstance(r, dict):
            continue
        sess = r.get("attendance_sessions")
        if not isinstance(sess, dict):
            continue
        name = (sess.get("subject_name") or sess.get("subject_code") or "").strip()
        if not name:
            continue
        entry = agg.setdefault(name, [sess.get("subject_code"), 0, 0])
        entry[1] += 1
        # The portal counts a late arrival as attended, so we must too.
        if str(r.get("status") or "").strip().lower() in ATTENDED_STATUSES:
            entry[2] += 1

    return [
        {
            "subject_name": name,
            "subject_code": code,
            "total_classes": total,
            "classes_attended": attended,
            # Left to _normalize_attendance so one rounding rule covers both sources.
            "attendance_percentage": None,
        }
        for name, (code, total, attended) in agg.items()
    ]


def _fetch_summary(session: requests.Session, token: str, roll: str) -> list[dict]:
    """Legacy pre-migration aggregate. Kept as a fallback for older history."""
    url = (
        f"{SUPABASE_URL}/rest/v1/student_attendance_summary"
        f"?student_id=eq.{roll}"
        "&select=subject_name,subject_code,total_classes,classes_attended,attendance_percentage"
    )
    return _get_rows(session, token, url, "attendance summary")


def _fetch_profile(session: requests.Session, roll: str) -> dict:
    """Roll number -> CampusHub profile (department/section/year/semester/name)."""
    try:
        resp = session.post(
            f"{CAMPUSHUB_BASE}/api/auth/login",
            json={"rollNumber": roll},
            timeout=_TIMEOUT,
        )
    except requests.Timeout as exc:
        raise ERPError("The college portal timed out. Please try again.", 504) from exc
    except requests.RequestException as exc:
        logger.warning("CampusHub profile request failed: %s", exc)
        raise ERPError("Could not reach the college portal. Please try again later.", 502) from exc

    if resp.status_code != 200:
        logger.warning("CampusHub profile status %s: %s", resp.status_code, resp.text[:200])
        return {}
    body = resp.json() or {}
    user = body.get("user")
    return user if isinstance(user, dict) else {}


def _fetch_timetable_rows(session: requests.Session, token: str, profile: dict) -> list[dict]:
    params = {
        k: profile.get(k)
        for k in ("department", "section", "year", "semester")
        if profile.get(k)
    }
    if not params:
        return []
    try:
        resp = session.get(
            f"{CAMPUSHUB_BASE}/api/student/timetable",
            params=params,
            headers={"Authorization": f"Bearer {token}"},
            timeout=_TIMEOUT,
        )
    except requests.Timeout as exc:
        raise ERPError("The college portal timed out. Please try again.", 504) from exc
    except requests.RequestException as exc:
        logger.warning("CampusHub timetable request failed: %s", exc)
        raise ERPError("Could not reach the college portal. Please try again later.", 502) from exc

    if resp.status_code != 200:
        logger.warning("CampusHub timetable status %s: %s", resp.status_code, resp.text[:200])
        return []
    body = resp.json() or {}
    rows = body.get("classes")
    return rows if isinstance(rows, list) else []


def _normalize_timetable(rows: list[dict], today: Optional[date] = None) -> tuple[list[dict], list[str]]:
    """
    Flatten CampusHub rows into BunkMax schedule entries.

    A row covers periods `period_start..period_end` (labs span several), so it
    is expanded into one entry per period. Only currently-active recurring rows
    are used — one-off classes must not overwrite the weekly grid.

    Returns (entries, conflicts). A conflict is a slot with two rows (batch-split
    labs, where CampusHub leaves `batch` null so we can't tell which is yours);
    the first by subject name wins and the loser is reported.
    """
    today = today or date.today()
    slots: dict[tuple[str, int], str] = {}
    conflicts: list[str] = []

    def active(r: dict) -> bool:
        if not r.get("is_recurring"):
            return False
        for key, keep_if_future in (("start_date", False), ("end_date", True)):
            raw = r.get(key)
            if not raw:
                continue
            try:
                d = date.fromisoformat(str(raw)[:10])
            except ValueError:
                continue
            if keep_if_future and d < today:
                return False       # ended already
            if not keep_if_future and d > today:
                return False       # hasn't started yet
        return True

    # Sort for deterministic conflict resolution.
    for r in sorted(
        (r for r in rows if isinstance(r, dict) and active(r)),
        key=lambda r: (str(r.get("subject_name") or ""), str(r.get("subject_code") or "")),
    ):
        day = WEEKDAY_NAMES.get(r.get("weekday"))
        name = (r.get("subject_name") or r.get("subject_code") or "").strip()
        if not day or not name:
            continue
        try:
            start = int(r.get("period_start") or 0)
            end = int(r.get("period_end") or start)
        except (TypeError, ValueError):
            continue
        if start < 1:
            continue
        for period in range(start, min(end, MAX_PERIOD) + 1):
            key = (day, period)
            if key in slots:
                if slots[key] != name:
                    conflicts.append(f"{day} period {period}: {slots[key]} / {name}")
                continue
            slots[key] = name

    entries = [
        {"day_name": day, "period_no": period, "subject_name": name}
        for (day, period), name in sorted(slots.items(), key=lambda kv: (kv[0][1], kv[0][0]))
    ]
    return entries, conflicts


def fetch_attendance(username: str, password: str, slug: str = DEFAULT_SLUG) -> dict:
    """
    Log in to CampusHub and return normalized attendance (same shape /import
    already consumes):

        {
          "subjects":   [{"subjectid": "<name>", "subject_name": "<name>"}, ...],
          "attendance": {"<name>": {"totalsessions": int,
                                     "presentSessionsCount": int,
                                     "percentage": "NN.NN"}},
          "average":    <float>,
          "student":    {"name": ..., "prn": <roll>, "stuid": <roll>},
        }

    Empty subjects/attendance is a valid result (no classes recorded yet).
    """
    return fetch_all(username, password, slug, with_timetable=False)


def _normalize_attendance(rows: list[dict], roll: str) -> dict:
    subjects: dict[str, str] = {}      # id -> name
    attendance: dict[str, dict] = {}
    pct_values: list[float] = []

    for r in rows:
        if not isinstance(r, dict):
            continue
        name = (r.get("subject_name") or r.get("subject_code") or "").strip()
        if not name:
            continue
        sub_id = name  # importer upserts on subject_name; name is the stable key
        total = int(r.get("total_classes") or 0)
        present = int(r.get("classes_attended") or 0)
        pct = r.get("attendance_percentage")
        if pct is None:
            pct = round((present / total) * 100, 2) if total else 0
        try:
            pct_values.append(float(pct))
        except (TypeError, ValueError):
            pass
        subjects[sub_id] = name
        attendance[sub_id] = {
            "totalsessions": total,
            "presentSessionsCount": present,
            "percentage": f"{float(pct):.2f}",
        }

    return {
        "subjects": [{"subjectid": sid, "subject_name": nm} for sid, nm in subjects.items()],
        "attendance": attendance,
        "average": round(sum(pct_values) / len(pct_values), 2) if pct_values else 0,
        "student": {"name": roll, "prn": roll, "stuid": roll},
    }


def fetch_all(username: str, password: str, slug: str = DEFAULT_SLUG,
              *, with_timetable: bool = True) -> dict:
    """
    One login, both datasets. Returns the `fetch_attendance` payload plus
    `timetable` (list of {day_name, period_no, subject_name}) and
    `timetable_conflicts`. A timetable failure is non-fatal — attendance still
    syncs and `timetable` comes back empty.
    """
    roll = (username or "").strip().upper()
    password = password or ""
    if not roll or not password:
        raise ERPError("ERP roll number and password are required.", 400)

    session = requests.Session()
    try:
        token = _login(session, f"{roll.lower()}@{EMAIL_DOMAIN}", password)

        # Preferred: CampusHub's own attendance module, already aggregated and
        # scoped to the current semester.
        module = _fetch_attendance_module(session, token)
        rows = module.get("subject_wise_attendance") or []
        overall = module.get("overall_stats") or {}

        if not rows:
            # The module gave us nothing. Fall back to reading Supabase
            # directly with the anon key — first the current session tables,
            # then the frozen legacy view for pre-migration history. Neither
            # accepts the Cognito idToken, so they use ANON_KEY.
            rows = _fetch_records(session, ANON_KEY, roll) or _fetch_summary(
                session, ANON_KEY, roll
            )

        result = _normalize_attendance(rows, roll)

        # The portal's own overall figure is total-based; our fallback average
        # is a mean of subject percentages. Prefer the portal's when present.
        pct = overall.get("attendance_percentage")
        if pct is not None:
            try:
                result["average"] = round(float(pct), 2)
            except (TypeError, ValueError):
                pass

        student = module.get("student")
        if isinstance(student, dict) and student.get("name"):
            result["student"]["name"] = student["name"]
        result["timetable"] = []
        result["timetable_conflicts"] = []

        if with_timetable:
            try:
                profile = _fetch_profile(session, roll)
                if profile.get("name"):
                    result["student"]["name"] = profile["name"]
                entries, conflicts = _normalize_timetable(
                    _fetch_timetable_rows(session, token, profile)
                )
                result["timetable"] = entries
                result["timetable_conflicts"] = conflicts
            except ERPError:
                logger.warning("Timetable sync failed for %s; attendance kept", roll)
        return result
    finally:
        session.close()


if __name__ == "__main__":  # ponytail: manual self-check, run with real creds
    import sys

    if len(sys.argv) == 3:
        import json

        print(json.dumps(fetch_all(sys.argv[1], sys.argv[2]), indent=2))
    else:
        # Offline checks of both normalizers.
        att = _normalize_attendance([
            {"subject_name": "DS", "subject_code": "DS", "total_classes": 4,
             "classes_attended": 3, "attendance_percentage": 75.0},
            {"subject_name": "OS", "total_classes": 0, "classes_attended": 0,
             "attendance_percentage": None},
        ], "24R21A0522")["attendance"]
        assert att["DS"] == {"totalsessions": 4, "presentSessionsCount": 3, "percentage": "75.00"}
        assert att["OS"] == {"totalsessions": 0, "presentSessionsCount": 0, "percentage": "0.00"}

        # Session-record aggregation: `late` counts as attended, `absent` does not.
        def _rec(status, name, code="C1"):
            return {"status": status,
                    "attendance_sessions": {"subject_name": name, "subject_code": code,
                                            "status": "closed"}}
        agg = _aggregate_records([
            _rec("present", "X"), _rec("late", "X"), _rec("absent", "X"),
            _rec("PRESENT", "Y"),                      # case-insensitive
            {"status": "present", "attendance_sessions": None},   # unjoined row
            "not-a-dict",
        ])
        by_name = {r["subject_name"]: r for r in agg}
        assert by_name["X"]["total_classes"] == 3, agg
        assert by_name["X"]["classes_attended"] == 2, agg
        assert by_name["Y"]["classes_attended"] == 1, agg
        assert set(by_name) == {"X", "Y"}, agg
        # and it feeds the shared normalizer cleanly
        assert _normalize_attendance(agg, "R")["attendance"]["X"]["percentage"] == "66.67"

        today = date.today()
        entries, conflicts = _normalize_timetable([
            # normal period
            {"weekday": 1, "period_start": 1, "period_end": 1, "subject_name": "CN",
             "is_recurring": True, "start_date": "2026-07-13"},
            # lab spanning 3 periods
            {"weekday": 2, "period_start": 4, "period_end": 6, "subject_name": "CN Lab",
             "is_recurring": True, "start_date": "2026-07-13"},
            # batch-split lab in the same slot -> conflict, first by name wins
            {"weekday": 2, "period_start": 4, "period_end": 6, "subject_name": "Cloud Lab",
             "is_recurring": True, "start_date": "2026-07-13"},
            # one-off class must be ignored
            {"weekday": 3, "period_start": 1, "period_end": 1, "subject_name": "Extra",
             "is_recurring": False, "start_date": "2026-08-04"},
            # not started yet / already ended
            {"weekday": 4, "period_start": 1, "period_end": 1, "subject_name": "Future",
             "is_recurring": True, "start_date": "2026-12-01"},
            {"weekday": 5, "period_start": 1, "period_end": 1, "subject_name": "Ended",
             "is_recurring": True, "start_date": "2026-01-01", "end_date": "2026-06-30"},
            # period_end beyond the 6-period grid must be clipped
            {"weekday": 6, "period_start": 6, "period_end": 9, "subject_name": "Sports",
             "is_recurring": True},
        ], today=today)
        got = {(e["day_name"], e["period_no"]): e["subject_name"] for e in entries}
        assert got == {
            ("Monday", 1): "CN",
            ("Tuesday", 4): "CN Lab", ("Tuesday", 5): "CN Lab", ("Tuesday", 6): "CN Lab",
            ("Saturday", 6): "Sports",
        }, got
        assert len(conflicts) == 3 and "CN Lab / Cloud Lab" in conflicts[0], conflicts
        assert all(1 <= e["period_no"] <= MAX_PERIOD for e in entries)
        print("self-check ok")
