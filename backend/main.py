from datetime import datetime, timedelta
from secrets import compare_digest
from typing import Any, Callable, Literal, Optional
from zoneinfo import ZoneInfo
import hashlib
import hmac
import logging
import math
import os

from database import get_conn
from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, model_validator
import razorpay

from push_notifications import send_push_to_tokens

razorpay_client = None
if os.getenv("RAZORPAY_KEY_ID") and os.getenv("RAZORPAY_KEY_SECRET"):
    razorpay_client = razorpay.Client(
        auth=(os.getenv("RAZORPAY_KEY_ID", ""), os.getenv("RAZORPAY_KEY_SECRET", ""))
    )



logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("bunkmax")

app = FastAPI(title="BunkMax API")


@app.get("/health")
def health_check():
    return {"status": "ok", "service": "bunkmax-api"}


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


def require_secret(
    env_name: str,
    provided_secret: Optional[str],
    label: str,
) -> None:
    expected_secret = os.getenv(env_name, "").strip()

    if not expected_secret:
        logger.error("%s is not configured", env_name)
        raise HTTPException(
            status_code=500,
            detail=f"{label} secret is not configured",
        )

    if not provided_secret or not compare_digest(provided_secret, expected_secret):
        raise HTTPException(
            status_code=401,
            detail=f"Invalid {label} secret",
        )


def require_service_secret(
    x_bunkmax_service_secret: Optional[str] = Header(
        default=None,
        alias="x-bunkmax-service-secret",
    )
) -> None:
    require_secret(
        "BACKEND_API_SECRET",
        x_bunkmax_service_secret,
        "service",
    )


def require_admin_secret(
    x_bunkmax_admin_secret: Optional[str] = Header(
        default=None,
        alias="x-bunkmax-admin-secret",
    )
) -> None:
    require_secret(
        "ADMIN_API_SECRET",
        x_bunkmax_admin_secret,
        "admin",
    )


def require_admin_db_routes_enabled(
    x_bunkmax_admin_secret: Optional[str] = Header(
        default=None,
        alias="x-bunkmax-admin-secret",
    )
) -> None:
    enabled = os.getenv("ENABLE_ADMIN_DB_ROUTES", "").strip().lower()

    if enabled not in {"1", "true", "yes", "on"}:
        raise HTTPException(status_code=404, detail="Not found")

    require_secret(
        "ADMIN_API_SECRET",
        x_bunkmax_admin_secret,
        "admin",
    )


def require_notification_cron_secret(
    secret: Optional[str] = Query(default=None),
    x_bunkmax_cron_secret: Optional[str] = Header(
        default=None,
        alias="x-bunkmax-cron-secret",
    ),
) -> None:
    expected_secret = (
        os.getenv("NOTIFICATION_CRON_SECRET", "").strip()
        or os.getenv("ADMIN_API_SECRET", "").strip()
    )

    if not expected_secret:
        logger.error("NOTIFICATION_CRON_SECRET or ADMIN_API_SECRET is not configured")
        raise HTTPException(
            status_code=500,
            detail="Notification cron secret is not configured",
        )

    provided_secret = x_bunkmax_cron_secret or secret

    if not provided_secret or not compare_digest(provided_secret, expected_secret):
        raise HTTPException(status_code=401, detail="Invalid notification cron secret")


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
    period_no: int = Field(..., ge=1, le=6)
    subject_name: str = Field(default="", max_length=255)


class GoogleUserPayload(BaseModel):
    email: str = Field(..., min_length=3, max_length=255)
    name: str = Field(default="Student", max_length=255)


class PushTokenPayload(BaseModel):
    user_id: int = Field(..., ge=1)
    token: str = Field(..., min_length=20, max_length=4096)
    platform: str = Field(default="", max_length=512)
    user_agent: str = Field(default="", max_length=512)


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


class SubscriptionCheckoutPayload(BaseModel):
    plan_id: Literal["pro_monthly", "pro_yearly"]


class SubscriptionPaymentVerificationPayload(BaseModel):
    razorpay_payment_id: Optional[str] = Field(default=None, max_length=255)
    razorpay_order_id: Optional[str] = Field(default=None, max_length=255)
    razorpay_signature: Optional[str] = Field(default=None, max_length=1024)


class SubscriptionUpdatePayload(BaseModel):
    plan_id: Literal["free", "pro_monthly", "pro_yearly"] = "free"
    status: Literal["free", "active", "cancelled", "past_due", "expired"] = "free"
    renews_at: Optional[datetime] = None
    provider: str = Field(default="", max_length=80)
    reference: str = Field(default="", max_length=255)

    @model_validator(mode="after")
    def validate_subscription_update(self):
        if self.plan_id == "free":
            self.status = "free"
            self.renews_at = None
            return self

        if self.status == "free":
            raise ValueError("Paid plans must use a paid subscription status")

        if self.status == "active" and self.renews_at is None:
            self.renews_at = datetime.now(ZoneInfo("UTC")) + PLAN_DURATIONS[self.plan_id]

        return self


WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
ALL_DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
VALID_DAYS = set(ALL_DAYS)
CLASS_PERIODS = 6

FREE_SUBSCRIPTION_PLAN = {
    "id": "free",
    "name": "Free",
    "price_rupees": 0,
    "billing_interval": "forever",
    "description": "Subscription required to unlock BunkMax.",
    "features": [],
    "highlighted": False,
}

SUBSCRIPTION_PLANS = [
    {
        "id": "pro_monthly",
        "name": "3 Month Plan",
        "price_rupees": 59,
        "billing_interval": "3 months",
        "description": "Affordable access for a full mid-semester stretch.",
        "features": [
            "Calendar-based bunk planning",
            "Smarter recovery targets",
            "Priority notification features",
            "Early access to student tools",
        ],
        "highlighted": False,
    },
    {
        "id": "pro_yearly",
        "name": "Semester Plan",
        "price_rupees": 89,
        "billing_interval": "6 months",
        "description": "Best value for one complete semester.",
        "features": [
            "Everything in the 3 Month Plan",
            "Lower semester price",
            "Semester-long planning support",
            "Priority feature requests",
        ],
        "highlighted": True,
    },
]

PLAN_DURATIONS = {
    "pro_monthly": timedelta(days=92),
    "pro_yearly": timedelta(days=183),
}

USER_SELECT_FIELDS = """
    id,
    name,
    email,
    college,
    branch,
    semester,
    section,
    default_target,
    COALESCE(subscription_plan, 'free') AS subscription_plan,
    COALESCE(subscription_status, 'free') AS subscription_status,
    subscription_started_at,
    subscription_renews_at,
    COALESCE(subscription_provider, '') AS subscription_provider,
    COALESCE(subscription_reference, '') AS subscription_reference
"""


def ensure_subscription_columns(conn) -> None:
    """Keep older databases compatible with the subscription gate."""

    statements = [
        """
            ALTER TABLE users
            ADD COLUMN IF NOT EXISTS subscription_plan TEXT DEFAULT 'free';
        """,
        """
            ALTER TABLE users
            ADD COLUMN IF NOT EXISTS subscription_status TEXT DEFAULT 'free';
        """,
        """
            ALTER TABLE users
            ADD COLUMN IF NOT EXISTS subscription_started_at TIMESTAMPTZ;
        """,
        """
            ALTER TABLE users
            ADD COLUMN IF NOT EXISTS subscription_renews_at TIMESTAMPTZ;
        """,
        """
            ALTER TABLE users
            ADD COLUMN IF NOT EXISTS subscription_provider TEXT DEFAULT '';
        """,
        """
            ALTER TABLE users
            ADD COLUMN IF NOT EXISTS subscription_reference TEXT DEFAULT '';
        """,
        """
            UPDATE users
            SET subscription_plan = 'free'
            WHERE subscription_plan IS NULL
               OR subscription_plan NOT IN ('free', 'pro_monthly', 'pro_yearly');
        """,
        """
            UPDATE users
            SET subscription_status = 'free'
            WHERE subscription_status IS NULL
               OR subscription_status NOT IN (
                    'free',
                    'active',
                    'cancelled',
                    'past_due',
                    'expired'
               );
        """,
        """
            UPDATE users
            SET subscription_status = 'free',
                subscription_renews_at = NULL
            WHERE subscription_plan = 'free';
        """,
        """
            UPDATE users
            SET subscription_provider = ''
            WHERE subscription_provider IS NULL;
        """,
        """
            UPDATE users
            SET subscription_reference = ''
            WHERE subscription_reference IS NULL;
        """,
    ]

    with conn.cursor() as cur:
        for statement in statements:
            cur.execute(statement)

    conn.commit()


def clean_text(value: Any) -> str:
    return str(value or "").strip()


def get_subscription_plan(plan_id: str) -> dict[str, Any]:
    if plan_id == "free":
        return FREE_SUBSCRIPTION_PLAN

    for plan in SUBSCRIPTION_PLANS:
        if plan["id"] == plan_id:
            return plan

    raise HTTPException(status_code=400, detail="Invalid subscription plan")


def subscription_payment_link(plan_id: str) -> str:
    plan_key = plan_id.upper()
    return (
        os.getenv(f"SUBSCRIPTION_{plan_key}_URL", "").strip()
        or os.getenv(f"RAZORPAY_{plan_key}_LINK", "").strip()
    )


def is_subscription_active(row: dict[str, Any]) -> bool:
    plan_id = clean_text(row.get("subscription_plan")) or "free"
    status = clean_text(row.get("subscription_status")) or "free"
    renews_at = row.get("subscription_renews_at")

    if plan_id == "free" or status != "active":
        return False

    if renews_at is None:
        return True

    if isinstance(renews_at, datetime):
        now = datetime.now(ZoneInfo("UTC"))

        if renews_at.tzinfo is None:
            renews_at = renews_at.replace(tzinfo=ZoneInfo("UTC"))

        return renews_at >= now

    return False


def build_user_response(row: dict[str, Any]) -> dict[str, Any]:
    user = dict(row)
    plan_id = clean_text(user.get("subscription_plan")) or "free"
    status = clean_text(user.get("subscription_status")) or "free"

    user["subscription_plan"] = plan_id
    user["subscription_status"] = status
    user["subscription_provider"] = clean_text(user.get("subscription_provider"))
    user["subscription_reference"] = clean_text(user.get("subscription_reference"))
    user["is_pro"] = is_subscription_active(user)

    return user


def build_subscription_response(row: dict[str, Any]) -> dict[str, Any]:
    user = build_user_response(row)
    plan = get_subscription_plan(user["subscription_plan"])

    return {
        "plan_id": user["subscription_plan"],
        "plan_name": plan["name"],
        "status": user["subscription_status"],
        "is_pro": user["is_pro"],
        "renews_at": user.get("subscription_renews_at"),
        "provider": user["subscription_provider"],
    }


def build_order_receipt(user_id: int) -> str:
    timestamp = int(datetime.now(ZoneInfo("UTC")).timestamp())
    return f"bm_{user_id}_{timestamp}"


def razorpay_error_response(exc: Exception, fallback: str) -> HTTPException:
    message = str(exc).lower()

    if "auth" in message or "key" in message or "unauthorized" in message:
        return HTTPException(status_code=401, detail="Razorpay authentication failed")

    return HTTPException(status_code=500, detail=fallback)


def verify_razorpay_signature(
    *,
    order_id: str,
    payment_id: str,
    signature: str,
) -> bool:
    key_secret = os.getenv("RAZORPAY_KEY_SECRET", "")

    if not key_secret:
        raise HTTPException(status_code=500, detail="Razorpay is not configured")

    message = f"{order_id}|{payment_id}".encode("utf-8")
    expected_signature = hmac.new(
        key_secret.encode("utf-8"),
        msg=message,
        digestmod=hashlib.sha256,
    ).hexdigest()

    return compare_digest(expected_signature, signature)


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


def get_tomorrow_name() -> str:
    return (datetime.now(ZoneInfo("Asia/Kolkata")) + timedelta(days=1)).strftime("%A")


def get_notification_date() -> str:
    return datetime.now(ZoneInfo("Asia/Kolkata")).date().isoformat()


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


def build_day_map(
    timetable_rows: list[dict[str, Any]]
) -> dict[str, list[dict[str, Any]]]:
    day_map: dict[str, list[dict[str, Any]]] = {}

    for row in timetable_rows:
        day = clean_text(row.get("day_name"))
        subject_name = clean_text(row.get("subject_name"))

        try:
            period_no = int(row.get("period_no") or 0)
        except Exception:
            period_no = 0

        if not day or day not in VALID_DAYS:
            continue

        if not subject_name:
            continue

        if period_no < 1 or period_no > CLASS_PERIODS:
            continue

        day_map.setdefault(day, []).append({
            "period_no": period_no,
            "subject_name": subject_name,
        })

    for classes in day_map.values():
        classes.sort(key=lambda item: int(item["period_no"]))

    return day_map


def format_class_count(count: int) -> str:
    if count == 1:
        return "1 class"

    return f"{count} classes"


def build_morning_notification(class_count: int) -> tuple[str, str]:
    title = "Today's classes"

    if class_count <= 0:
        return title, "No classes are saved for today. Check BunkMax if your timetable changed."

    return (
        title,
        f"You have {format_class_count(class_count)} today. Check skippable classes.",
    )


def build_evening_notification(class_count: int) -> tuple[str, str]:
    title = "Check tomorrow"

    if class_count <= 0:
        return title, "Check tomorrow's classes and attendance in BunkMax."

    return (
        title,
        f"Tomorrow has {format_class_count(class_count)} scheduled. Check classes and attendance in BunkMax.",
    )


def load_unsent_notification_recipients(
    notification_type: str,
    sent_date: str,
    day_name: str,
) -> list[dict[str, Any]]:
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT
                    push_tokens.user_id,
                    push_tokens.token,
                    COALESCE(classes.class_count, 0) AS class_count
                FROM push_tokens
                LEFT JOIN (
                    SELECT user_id, COUNT(*) AS class_count
                    FROM timetable
                    WHERE day_name = %s
                      AND subject_name IS NOT NULL
                      AND TRIM(subject_name) != ''
                    GROUP BY user_id
                ) classes ON classes.user_id = push_tokens.user_id
                LEFT JOIN notification_logs
                  ON notification_logs.user_id = push_tokens.user_id
                 AND notification_logs.notification_type = %s
                 AND notification_logs.sent_date = %s
                WHERE notification_logs.id IS NULL
                ORDER BY push_tokens.user_id
            """, (day_name, notification_type, sent_date))

            return cur.fetchall()
    finally:
        conn.close()


def mark_notifications_sent(
    user_ids: set[int],
    notification_type: str,
    sent_date: str,
) -> None:
    if not user_ids:
        return

    conn = get_conn()
    try:
        with conn.cursor() as cur:
            for user_id in user_ids:
                cur.execute("""
                    INSERT INTO notification_logs (
                        user_id,
                        notification_type,
                        sent_date,
                        sent_at
                    )
                    VALUES (%s, %s, %s, NOW())
                    ON CONFLICT (user_id, notification_type, sent_date)
                    DO NOTHING
                """, (user_id, notification_type, sent_date))

            conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def send_class_count_notification_batch(
    notification_type: str,
    day_name: str,
    tag: str,
    build_message: Callable[[int], tuple[str, str]],
) -> dict[str, Any]:
    sent_date = get_notification_date()
    rows = load_unsent_notification_recipients(
        notification_type,
        sent_date,
        day_name,
    )

    grouped: dict[tuple[str, str], dict[str, Any]] = {}

    for row in rows:
        try:
            class_count = int(row.get("class_count") or 0)
            user_id = int(row["user_id"])
        except Exception:
            continue

        token = clean_text(row.get("token"))

        if not token:
            continue

        title, body = build_message(class_count)
        group = grouped.setdefault(
            (title, body),
            {
                "tokens": [],
                "user_ids": set(),
            },
        )

        group["tokens"].append(token)
        group["user_ids"].add(user_id)

    token_count = 0
    success_count = 0
    failure_count = 0
    logged_user_ids: set[int] = set()

    for (title, body), group in grouped.items():
        result = send_push_to_tokens(
            group["tokens"],
            title,
            body,
            url="/",
            tag=tag,
            ttl_seconds=43200,
        )

        token_count += int(result.get("token_count") or 0)
        success_count += int(result.get("success_count") or 0)
        failure_count += int(result.get("failure_count") or 0)
        logged_user_ids.update(group["user_ids"])
        mark_notifications_sent(group["user_ids"], notification_type, sent_date)

    return {
        "message": "Notifications processed.",
        "notification_type": notification_type,
        "day_name": day_name,
        "date": sent_date,
        "users_notified": len(logged_user_ids),
        "token_count": token_count,
        "success_count": success_count,
        "failure_count": failure_count,
        "groups": len(grouped),
    }


def get_next_valid_class_day(day_map: dict[str, list[dict[str, Any]]]) -> Optional[str]:
    today = datetime.now(ZoneInfo("Asia/Kolkata")).date()

    for i in range(1, 8):
        check_date = today + timedelta(days=i)
        day_name = check_date.strftime("%A")

        classes = day_map.get(day_name, [])
        if any(clean_text(c.get("subject_name")) for c in classes):
            return day_name

    return None


def simulate_absence_for_subjects(
    subjects: list[dict[str, Any]],
    missed_classes: list[dict[str, Any]],
) -> dict[str, float]:
    simulated = [
        {
            "subject_name": s["subject_name"],
            "attended_classes": int(s.get("attended_classes") or 0),
            "total_classes": int(s.get("total_classes") or 0),
        }
        for s in subjects
    ]

    for missed_class in missed_classes:
        missed_clean = clean_text(missed_class.get("subject_name")).lower()

        for s in simulated:
            if clean_text(s["subject_name"]).lower() == missed_clean:
                s["total_classes"] += 1
                break

    return {
        "new_overall": calc_overall(simulated),
        "new_avg": calc_avg(simulated),
    }


@app.get("/")
def root():
    return {
        "message": "BunkMax API running",
        "allowed_origins": get_allowed_origins(),
    }


@app.get("/init-db")
def init_db(_: None = Depends(require_admin_db_routes_enabled)):
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
                    default_target INTEGER DEFAULT 75,
                    subscription_plan TEXT DEFAULT 'free',
                    subscription_status TEXT DEFAULT 'free',
                    subscription_started_at TIMESTAMPTZ,
                    subscription_renews_at TIMESTAMPTZ,
                    subscription_provider TEXT DEFAULT '',
                    subscription_reference TEXT DEFAULT '',
                    CONSTRAINT users_email_unique UNIQUE (email),
                    CONSTRAINT users_default_target_check
                        CHECK (default_target >= 1 AND default_target <= 100)
                );
            """)

            cur.execute("""
                CREATE TABLE IF NOT EXISTS subjects (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    subject_name TEXT NOT NULL,
                    attended_classes INTEGER DEFAULT 0,
                    total_classes INTEGER DEFAULT 0,
                    required_percentage INTEGER DEFAULT 75,
                    UNIQUE(user_id, subject_name),
                    CONSTRAINT subjects_attended_non_negative
                        CHECK (attended_classes >= 0),
                    CONSTRAINT subjects_total_non_negative
                        CHECK (total_classes >= 0),
                    CONSTRAINT subjects_attended_lte_total
                        CHECK (attended_classes <= total_classes),
                    CONSTRAINT subjects_required_percentage_check
                        CHECK (required_percentage >= 1 AND required_percentage <= 100),
                    CONSTRAINT subjects_name_not_empty
                        CHECK (TRIM(subject_name) != '')
                );
            """)

            cur.execute("""
                CREATE TABLE IF NOT EXISTS timetable (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    day_name TEXT NOT NULL,
                    period_no INTEGER NOT NULL,
                    subject_name TEXT DEFAULT '',
                    UNIQUE(user_id, day_name, period_no),
                    CONSTRAINT timetable_day_name_check
                        CHECK (
                            day_name IN (
                                'Monday',
                                'Tuesday',
                                'Wednesday',
                                'Thursday',
                                'Friday',
                                'Saturday',
                                'Sunday'
                            )
                        ),
                    CONSTRAINT timetable_period_no_check
                        CHECK (period_no >= 1 AND period_no <= 6)
                );
            """)

            cur.execute("""
                CREATE TABLE IF NOT EXISTS push_tokens (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    token TEXT NOT NULL UNIQUE,
                    platform TEXT DEFAULT '',
                    user_agent TEXT DEFAULT '',
                    created_at TIMESTAMPTZ DEFAULT NOW(),
                    updated_at TIMESTAMPTZ DEFAULT NOW()
                );
            """)

            cur.execute("""
                CREATE TABLE IF NOT EXISTS notification_logs (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    notification_type TEXT NOT NULL,
                    sent_date DATE NOT NULL,
                    sent_at TIMESTAMPTZ DEFAULT NOW(),
                    UNIQUE(user_id, notification_type, sent_date)
                );
            """)

            cur.execute("""
                CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower
                ON users (LOWER(email));
            """)

            cur.execute("""
                CREATE INDEX IF NOT EXISTS idx_subjects_user_id
                ON subjects(user_id);
            """)

            cur.execute("""
                CREATE INDEX IF NOT EXISTS idx_timetable_user_id
                ON timetable(user_id);
            """)

            cur.execute("""
                CREATE INDEX IF NOT EXISTS idx_timetable_user_day
                ON timetable(user_id, day_name);
            """)

            cur.execute("""
                CREATE INDEX IF NOT EXISTS idx_push_tokens_user_id
                ON push_tokens(user_id);
            """)

            cur.execute("""
                CREATE INDEX IF NOT EXISTS idx_notification_logs_user_date
                ON notification_logs(user_id, sent_date);
            """)

            conn.commit()

        logger.info("Database initialized successfully")
        return {"message": "Database initialized successfully."}

    except Exception:
        logger.exception("Database initialization failed")
        raise HTTPException(status_code=500, detail="Database initialization failed")
    finally:
        conn.close()


@app.get("/migrate-db")
def migrate_db(_: None = Depends(require_admin_db_routes_enabled)):
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                UPDATE users
                SET email = ''
                WHERE email IS NULL;
            """)

            cur.execute("""
                UPDATE users
                SET default_target = 75
                WHERE default_target IS NULL
                   OR default_target < 1
                   OR default_target > 100;
            """)

            cur.execute("""
                ALTER TABLE users
                ADD COLUMN IF NOT EXISTS subscription_plan TEXT DEFAULT 'free';
            """)

            cur.execute("""
                ALTER TABLE users
                ADD COLUMN IF NOT EXISTS subscription_status TEXT DEFAULT 'free';
            """)

            cur.execute("""
                ALTER TABLE users
                ADD COLUMN IF NOT EXISTS subscription_started_at TIMESTAMPTZ;
            """)

            cur.execute("""
                ALTER TABLE users
                ADD COLUMN IF NOT EXISTS subscription_renews_at TIMESTAMPTZ;
            """)

            cur.execute("""
                ALTER TABLE users
                ADD COLUMN IF NOT EXISTS subscription_provider TEXT DEFAULT '';
            """)

            cur.execute("""
                ALTER TABLE users
                ADD COLUMN IF NOT EXISTS subscription_reference TEXT DEFAULT '';
            """)

            cur.execute("""
                UPDATE users
                SET subscription_plan = 'free'
                WHERE subscription_plan IS NULL
                   OR subscription_plan NOT IN ('free', 'pro_monthly', 'pro_yearly');
            """)

            cur.execute("""
                UPDATE users
                SET subscription_status = 'free'
                WHERE subscription_status IS NULL
                   OR subscription_status NOT IN (
                        'free',
                        'active',
                        'cancelled',
                        'past_due',
                        'expired'
                   );
            """)

            cur.execute("""
                UPDATE users
                SET subscription_status = 'free',
                    subscription_renews_at = NULL
                WHERE subscription_plan = 'free';
            """)

            cur.execute("""
                UPDATE users
                SET subscription_provider = ''
                WHERE subscription_provider IS NULL;
            """)

            cur.execute("""
                UPDATE users
                SET subscription_reference = ''
                WHERE subscription_reference IS NULL;
            """)

            cur.execute("""
                DELETE FROM subjects
                WHERE user_id NOT IN (SELECT id FROM users);
            """)

            cur.execute("""
                DELETE FROM timetable
                WHERE user_id NOT IN (SELECT id FROM users);
            """)

            cur.execute("""
                DELETE FROM timetable
                WHERE day_name NOT IN (
                    'Monday',
                    'Tuesday',
                    'Wednesday',
                    'Thursday',
                    'Friday',
                    'Saturday',
                    'Sunday'
                )
                OR period_no < 1
                OR period_no > 6;
            """)

            cur.execute("""
                CREATE TABLE IF NOT EXISTS push_tokens (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    token TEXT NOT NULL UNIQUE,
                    platform TEXT DEFAULT '',
                    user_agent TEXT DEFAULT '',
                    created_at TIMESTAMPTZ DEFAULT NOW(),
                    updated_at TIMESTAMPTZ DEFAULT NOW()
                );
            """)

            cur.execute("""
                CREATE TABLE IF NOT EXISTS notification_logs (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    notification_type TEXT NOT NULL,
                    sent_date DATE NOT NULL,
                    sent_at TIMESTAMPTZ DEFAULT NOW(),
                    UNIQUE(user_id, notification_type, sent_date)
                );
            """)

            cur.execute("""
                DELETE FROM push_tokens
                WHERE user_id NOT IN (SELECT id FROM users);
            """)

            cur.execute("""
                DELETE FROM notification_logs
                WHERE user_id NOT IN (SELECT id FROM users);
            """)

            cur.execute("""
                UPDATE subjects
                SET subject_name = TRIM(subject_name)
                WHERE subject_name IS NOT NULL;
            """)

            cur.execute("""
                DELETE FROM subjects
                WHERE subject_name IS NULL
                   OR TRIM(subject_name) = '';
            """)

            cur.execute("""
                UPDATE subjects
                SET attended_classes = 0
                WHERE attended_classes IS NULL OR attended_classes < 0;
            """)

            cur.execute("""
                UPDATE subjects
                SET total_classes = 0
                WHERE total_classes IS NULL OR total_classes < 0;
            """)

            cur.execute("""
                UPDATE subjects
                SET attended_classes = total_classes
                WHERE attended_classes > total_classes;
            """)

            cur.execute("""
                UPDATE subjects
                SET required_percentage = 75
                WHERE required_percentage IS NULL
                   OR required_percentage < 1
                   OR required_percentage > 100;
            """)

            cur.execute("""
                DO $$
                BEGIN
                    IF NOT EXISTS (
                        SELECT 1 FROM pg_constraint
                        WHERE conname = 'users_default_target_check'
                    ) THEN
                        ALTER TABLE users
                        ADD CONSTRAINT users_default_target_check
                        CHECK (default_target >= 1 AND default_target <= 100);
                    END IF;
                END $$;
            """)

            cur.execute("""
                DO $$
                BEGIN
                    IF NOT EXISTS (
                        SELECT 1 FROM pg_constraint
                        WHERE conname = 'subjects_user_id_fkey'
                    ) THEN
                        ALTER TABLE subjects
                        ADD CONSTRAINT subjects_user_id_fkey
                        FOREIGN KEY (user_id)
                        REFERENCES users(id)
                        ON DELETE CASCADE;
                    END IF;
                END $$;
            """)

            cur.execute("""
                DO $$
                BEGIN
                    IF NOT EXISTS (
                        SELECT 1 FROM pg_constraint
                        WHERE conname = 'subjects_attended_non_negative'
                    ) THEN
                        ALTER TABLE subjects
                        ADD CONSTRAINT subjects_attended_non_negative
                        CHECK (attended_classes >= 0);
                    END IF;
                END $$;
            """)

            cur.execute("""
                DO $$
                BEGIN
                    IF NOT EXISTS (
                        SELECT 1 FROM pg_constraint
                        WHERE conname = 'subjects_total_non_negative'
                    ) THEN
                        ALTER TABLE subjects
                        ADD CONSTRAINT subjects_total_non_negative
                        CHECK (total_classes >= 0);
                    END IF;
                END $$;
            """)

            cur.execute("""
                DO $$
                BEGIN
                    IF NOT EXISTS (
                        SELECT 1 FROM pg_constraint
                        WHERE conname = 'subjects_attended_lte_total'
                    ) THEN
                        ALTER TABLE subjects
                        ADD CONSTRAINT subjects_attended_lte_total
                        CHECK (attended_classes <= total_classes);
                    END IF;
                END $$;
            """)

            cur.execute("""
                DO $$
                BEGIN
                    IF NOT EXISTS (
                        SELECT 1 FROM pg_constraint
                        WHERE conname = 'subjects_required_percentage_check'
                    ) THEN
                        ALTER TABLE subjects
                        ADD CONSTRAINT subjects_required_percentage_check
                        CHECK (required_percentage >= 1 AND required_percentage <= 100);
                    END IF;
                END $$;
            """)

            cur.execute("""
                DO $$
                BEGIN
                    IF NOT EXISTS (
                        SELECT 1 FROM pg_constraint
                        WHERE conname = 'subjects_name_not_empty'
                    ) THEN
                        ALTER TABLE subjects
                        ADD CONSTRAINT subjects_name_not_empty
                        CHECK (TRIM(subject_name) != '');
                    END IF;
                END $$;
            """)

            cur.execute("""
                DO $$
                BEGIN
                    IF NOT EXISTS (
                        SELECT 1 FROM pg_constraint
                        WHERE conname = 'timetable_user_id_fkey'
                    ) THEN
                        ALTER TABLE timetable
                        ADD CONSTRAINT timetable_user_id_fkey
                        FOREIGN KEY (user_id)
                        REFERENCES users(id)
                        ON DELETE CASCADE;
                    END IF;
                END $$;
            """)

            cur.execute("""
                DO $$
                BEGIN
                    IF NOT EXISTS (
                        SELECT 1 FROM pg_constraint
                        WHERE conname = 'timetable_day_name_check'
                    ) THEN
                        ALTER TABLE timetable
                        ADD CONSTRAINT timetable_day_name_check
                        CHECK (
                            day_name IN (
                                'Monday',
                                'Tuesday',
                                'Wednesday',
                                'Thursday',
                                'Friday',
                                'Saturday',
                                'Sunday'
                            )
                        );
                    END IF;
                END $$;
            """)

            cur.execute("""
                DO $$
                BEGIN
                    IF NOT EXISTS (
                        SELECT 1 FROM pg_constraint
                        WHERE conname = 'timetable_period_no_check'
                    ) THEN
                        ALTER TABLE timetable
                        ADD CONSTRAINT timetable_period_no_check
                        CHECK (period_no >= 1 AND period_no <= 6);
                    END IF;
                END $$;
            """)

            cur.execute("""
                CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower_non_empty
                ON users (LOWER(email))
                WHERE TRIM(email) != '';
            """)

            cur.execute("""
                CREATE INDEX IF NOT EXISTS idx_subjects_user_id
                ON subjects(user_id);
            """)

            cur.execute("""
                CREATE INDEX IF NOT EXISTS idx_timetable_user_id
                ON timetable(user_id);
            """)

            cur.execute("""
                CREATE INDEX IF NOT EXISTS idx_timetable_user_day
                ON timetable(user_id, day_name);
            """)

            cur.execute("""
                CREATE INDEX IF NOT EXISTS idx_push_tokens_user_id
                ON push_tokens(user_id);
            """)

            cur.execute("""
                CREATE INDEX IF NOT EXISTS idx_notification_logs_user_date
                ON notification_logs(user_id, sent_date);
            """)

            conn.commit()

        logger.info("Database migration completed successfully")
        return {"message": "Database migration completed successfully."}

    except Exception:
        logger.exception("Database migration failed")
        raise HTTPException(status_code=500, detail="Database migration failed")
    finally:
        conn.close()


@app.post("/auth/google-user")
def auth_google_user(
    payload: GoogleUserPayload,
    _: None = Depends(require_service_secret),
):
    email = clean_text(payload.email).lower()
    name = clean_text(payload.name) or "Student"

    if not email.endswith("@mlrit.ac.in"):
        raise HTTPException(status_code=403, detail="Only MLRIT accounts allowed")

    conn = get_conn()
    try:
        ensure_subscription_columns(conn)

        with conn.cursor() as cur:
            cur.execute(f"""
                SELECT {USER_SELECT_FIELDS}
                FROM users
                WHERE LOWER(email) = %s
            """, (email,))
            user = cur.fetchone()

            if user:
                return build_user_response(user)

            cur.execute(f"""
                INSERT INTO users (name, email, college, branch, semester, section, default_target)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                RETURNING {USER_SELECT_FIELDS}
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

            logger.info("New user created: %s", email)
            return build_user_response(new_user)

    except HTTPException:
        raise
    except Exception:
        logger.exception("Auth failed for %s", email)
        raise HTTPException(status_code=500, detail="Authentication failed")
    finally:
        conn.close()


@app.get("/users/{user_id}")
def get_user(user_id: int, _: None = Depends(require_service_secret)):
    conn = get_conn()
    try:
        ensure_subscription_columns(conn)

        with conn.cursor() as cur:
            cur.execute(f"""
                SELECT {USER_SELECT_FIELDS}
                FROM users
                WHERE id = %s
            """, (user_id,))
            user = cur.fetchone()

            if not user:
                raise HTTPException(status_code=404, detail="User not found")

            return build_user_response(user)

    except HTTPException:
        raise
    except Exception:
        logger.exception("Failed to get user %s", user_id)
        raise HTTPException(status_code=500, detail="Failed to fetch user")
    finally:
        conn.close()


@app.get("/users/{user_id}/subscription")
def get_user_subscription(user_id: int, _: None = Depends(require_service_secret)):
    conn = get_conn()
    try:
        ensure_subscription_columns(conn)

        with conn.cursor() as cur:
            cur.execute(f"""
                SELECT {USER_SELECT_FIELDS}
                FROM users
                WHERE id = %s
            """, (user_id,))
            user = cur.fetchone()

            if not user:
                raise HTTPException(status_code=404, detail="User not found")

        return {
            "current": build_subscription_response(user),
            "plans": SUBSCRIPTION_PLANS,
        }

    except HTTPException:
        raise
    except Exception:
        logger.exception("Failed to fetch subscription for user %s", user_id)
        raise HTTPException(status_code=500, detail="Failed to fetch subscription")
    finally:
        conn.close()


@app.post("/users/{user_id}/subscription/create-order")
@app.post("/users/{user_id}/subscription/checkout")
def create_subscription_order(
    user_id: int,
    payload: SubscriptionCheckoutPayload,
    _: None = Depends(require_service_secret),
):
    conn = get_conn()
    try:
        plan = get_subscription_plan(payload.plan_id)
        amount_paise = int(plan["price_rupees"]) * 100

        if amount_paise < 100:
            raise HTTPException(
                status_code=400,
                detail="Minimum order amount is 100 paise",
            )

        with conn.cursor() as cur:
            cur.execute("""
                SELECT id, email, name
                FROM users
                WHERE id = %s
            """, (user_id,))
            user = cur.fetchone()

            if not user:
                raise HTTPException(status_code=404, detail="User not found")

        if not razorpay_client:
            raise HTTPException(
                status_code=500,
                detail="Razorpay is not configured on the server."
            )

        order_data = {
            "amount": amount_paise,
            "currency": "INR",
            "receipt": build_order_receipt(user_id),
            "notes": {
                "user_id": str(user_id),
                "plan_id": payload.plan_id,
                "student_email": clean_text(user.get("email")),
            },
        }

        try:
            order = razorpay_client.order.create(data=order_data)
        except (
            razorpay.errors.BadRequestError,
            razorpay.errors.GatewayError,
            razorpay.errors.ServerError,
        ) as exc:
            raise razorpay_error_response(exc, "Failed to create Razorpay order")

        return {
            "provider": "razorpay",
            "plan": plan,
            "order_id": order.get("id"),
            "amount": order.get("amount", amount_paise),
            "currency": order.get("currency", "INR"),
            "amount_rupees": plan["price_rupees"],
            "message": "Order is ready.",
        }

    except HTTPException:
        raise
    except Exception:
        logger.exception("Failed to create checkout for user %s", user_id)
        raise HTTPException(status_code=500, detail="Failed to create checkout")
    finally:
        conn.close()


@app.post("/users/{user_id}/subscription/verify-payment")
def verify_subscription_payment(
    user_id: int,
    payload: SubscriptionPaymentVerificationPayload,
    _: None = Depends(require_service_secret),
):
    payment_id = clean_text(payload.razorpay_payment_id)
    order_id = clean_text(payload.razorpay_order_id)
    signature = clean_text(payload.razorpay_signature)

    if not payment_id or not order_id or not signature:
        raise HTTPException(status_code=400, detail="Missing payment verification fields")

    if not razorpay_client:
        raise HTTPException(
            status_code=500,
            detail="Razorpay is not configured on the server.",
        )

    if not verify_razorpay_signature(
        order_id=order_id,
        payment_id=payment_id,
        signature=signature,
    ):
        raise HTTPException(status_code=400, detail="Payment signature mismatch")

    try:
        order = razorpay_client.order.fetch(order_id)
    except (
        razorpay.errors.BadRequestError,
        razorpay.errors.GatewayError,
        razorpay.errors.ServerError,
    ) as exc:
        raise razorpay_error_response(exc, "Failed to verify Razorpay order")

    notes = order.get("notes") or {}
    order_user_id = clean_text(notes.get("user_id"))
    plan_id = clean_text(notes.get("plan_id"))

    if order_user_id != str(user_id):
        raise HTTPException(status_code=400, detail="Payment does not belong to this user")

    plan = get_subscription_plan(plan_id)
    amount_paise = int(plan["price_rupees"]) * 100

    if int(order.get("amount") or 0) != amount_paise:
        raise HTTPException(status_code=400, detail="Payment amount mismatch")

    if clean_text(order.get("currency")).upper() != "INR":
        raise HTTPException(status_code=400, detail="Payment currency mismatch")

    conn = get_conn()
    try:
        ensure_subscription_columns(conn)

        with conn.cursor() as cur:
            renews_at = datetime.now(ZoneInfo("UTC")) + PLAN_DURATIONS.get(
                plan_id,
                timedelta(days=92),
            )
            cur.execute(f"""
                UPDATE users
                SET subscription_plan = %s,
                    subscription_status = 'active',
                    subscription_started_at = COALESCE(subscription_started_at, NOW()),
                    subscription_renews_at = %s,
                    subscription_provider = 'razorpay',
                    subscription_reference = %s
                WHERE id = %s
                RETURNING {USER_SELECT_FIELDS}
            """, (plan_id, renews_at, payment_id, user_id))
            user = cur.fetchone()

            if not user:
                raise HTTPException(status_code=404, detail="User not found")

            conn.commit()

        return {
            "message": "Payment verified successfully.",
            "current": build_subscription_response(user),
        }

    except HTTPException:
        raise
    except Exception:
        logger.exception("Failed to activate subscription for user %s", user_id)
        raise HTTPException(status_code=500, detail="Failed to activate subscription")
    finally:
        conn.close()


@app.post("/webhooks/razorpay")
async def razorpay_webhook(request: Request):
    payload = await request.body()
    signature = request.headers.get("x-razorpay-signature")
    webhook_secret = os.getenv("RAZORPAY_WEBHOOK_SECRET", "")

    if not signature or not webhook_secret:
        raise HTTPException(status_code=400, detail="Missing signature or secret")

    # Verify signature
    expected_sig = hmac.new(
        bytes(webhook_secret, "latin-1"),
        msg=payload,
        digestmod=hashlib.sha256
    ).hexdigest()

    if not compare_digest(expected_sig, signature):
        logger.error("Invalid Razorpay webhook signature")
        raise HTTPException(status_code=400, detail="Invalid signature")

    try:
        data = await request.json()
        event = data.get("event")

        if event in ["payment_link.paid", "order.paid"]:
            entity = data.get("payload", {}).get("payment_link", {}).get("entity", {})
            if event == "order.paid":
                entity = data.get("payload", {}).get("order", {}).get("entity", {})
            
            notes = entity.get("notes", {})
            user_id_str = notes.get("user_id")
            plan_id = notes.get("plan_id")
            reference = entity.get("id")

            if not user_id_str or not plan_id:
                return {"status": "ok", "message": "Ignored - no user_id or plan_id"}

            user_id = int(user_id_str)

            # Update database
            conn = get_conn()
            try:
                ensure_subscription_columns(conn)

                with conn.cursor() as cur:
                    renews_at = datetime.now(ZoneInfo("UTC")) + PLAN_DURATIONS.get(plan_id, timedelta(days=92))
                    cur.execute("""
                        UPDATE users
                        SET subscription_plan = %s,
                            subscription_status = 'active',
                            subscription_started_at = COALESCE(subscription_started_at, NOW()),
                            subscription_renews_at = %s,
                            subscription_provider = 'razorpay',
                            subscription_reference = %s
                        WHERE id = %s
                    """, (plan_id, renews_at, reference, user_id))
                    conn.commit()
                    logger.info("Activated subscription for user %s, plan %s", user_id, plan_id)
            finally:
                conn.close()

        return {"status": "ok"}
    except Exception:
        logger.exception("Error processing webhook")
        raise HTTPException(status_code=500, detail="Webhook processing failed")



@app.post("/admin/users/{user_id}/subscription")
def admin_update_subscription(
    user_id: int,
    payload: SubscriptionUpdatePayload,
    _: None = Depends(require_admin_secret),
):
    conn = get_conn()
    try:
        ensure_subscription_columns(conn)

        with conn.cursor() as cur:
            cur.execute(f"""
                UPDATE users
                SET subscription_plan = %s,
                    subscription_status = %s,
                    subscription_started_at = CASE
                        WHEN %s = 'free' THEN NULL
                        WHEN %s = 'active' THEN COALESCE(subscription_started_at, NOW())
                        ELSE subscription_started_at
                    END,
                    subscription_renews_at = %s,
                    subscription_provider = %s,
                    subscription_reference = %s
                WHERE id = %s
                RETURNING {USER_SELECT_FIELDS}
            """, (
                payload.plan_id,
                payload.status,
                payload.plan_id,
                payload.status,
                payload.renews_at,
                payload.provider.strip(),
                payload.reference.strip(),
                user_id,
            ))

            user = cur.fetchone()

            if not user:
                raise HTTPException(status_code=404, detail="User not found")

            conn.commit()

        return {
            "message": "Subscription updated successfully.",
            "current": build_subscription_response(user),
        }

    except HTTPException:
        raise
    except Exception:
        logger.exception("Failed to update subscription for user %s", user_id)
        raise HTTPException(status_code=500, detail="Failed to update subscription")
    finally:
        conn.close()


@app.put("/users/{user_id}")
def update_user(
    user_id: int,
    payload: UserPayload,
    _: None = Depends(require_service_secret),
):
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
        logger.exception("Failed to update user %s", user_id)
        raise HTTPException(status_code=500, detail="Failed to update user")
    finally:
        conn.close()


@app.post("/api/save-token")
def save_push_token(
    payload: PushTokenPayload,
    _: None = Depends(require_service_secret),
):
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT id
                FROM users
                WHERE id = %s
            """, (payload.user_id,))

            user = cur.fetchone()

            if not user:
                raise HTTPException(status_code=404, detail="User not found")

            cur.execute("""
                INSERT INTO push_tokens (
                    user_id,
                    token,
                    platform,
                    user_agent,
                    created_at,
                    updated_at
                )
                VALUES (%s, %s, %s, %s, NOW(), NOW())
                ON CONFLICT (token)
                DO UPDATE SET
                    user_id = EXCLUDED.user_id,
                    platform = EXCLUDED.platform,
                    user_agent = EXCLUDED.user_agent,
                    updated_at = NOW()
            """, (
                payload.user_id,
                payload.token.strip(),
                payload.platform.strip(),
                payload.user_agent.strip(),
            ))

            conn.commit()

        return {"message": "Push token saved successfully."}

    except HTTPException:
        raise
    except Exception:
        logger.exception("Failed to save push token for user %s", payload.user_id)
        raise HTTPException(status_code=500, detail="Failed to save push token")
    finally:
        conn.close()


@app.get("/cron/notifications/morning")
@app.post("/cron/notifications/morning")
def send_morning_notifications(
    _: None = Depends(require_notification_cron_secret),
):
    try:
        return send_class_count_notification_batch(
            notification_type="morning_summary",
            day_name=get_today_name(),
            tag="bunkmax-morning-summary",
            build_message=build_morning_notification,
        )
    except Exception:
        logger.exception("Failed to send morning notifications")
        raise HTTPException(
            status_code=500,
            detail="Failed to send morning notifications",
        )


@app.get("/cron/notifications/evening")
@app.post("/cron/notifications/evening")
def send_evening_notifications(
    _: None = Depends(require_notification_cron_secret),
):
    try:
        return send_class_count_notification_batch(
            notification_type="evening_reminder",
            day_name=get_tomorrow_name(),
            tag="bunkmax-evening-reminder",
            build_message=build_evening_notification,
        )
    except Exception:
        logger.exception("Failed to send evening notifications")
        raise HTTPException(
            status_code=500,
            detail="Failed to send evening notifications",
        )


@app.post("/users/{user_id}/import-attendance")
def import_attendance(
    user_id: int,
    payload: ERPImportPayload,
    _: None = Depends(require_service_secret),
):
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
        logger.exception("Import failed for user %s", user_id)
        raise HTTPException(status_code=500, detail="Import failed")
    finally:
        conn.close()


@app.get("/users/{user_id}/subjects")
def get_subjects(user_id: int, _: None = Depends(require_service_secret)):
    try:
        rows = load_subjects_raw(user_id)
        return [build_subject_response(r) for r in rows]
    except Exception:
        logger.exception("Failed to fetch subjects for user %s", user_id)
        raise HTTPException(status_code=500, detail="Failed to fetch subjects")


@app.post("/users/{user_id}/subjects")
def save_subject(
    user_id: int,
    payload: SubjectPayload,
    _: None = Depends(require_service_secret),
):
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
        logger.exception("Failed to save subject for user %s", user_id)
        raise HTTPException(status_code=500, detail="Failed to save subject")
    finally:
        conn.close()


@app.delete("/users/{user_id}/subjects/{subject_id}")
def delete_subject(
    user_id: int,
    subject_id: int,
    _: None = Depends(require_service_secret),
):
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
        logger.exception("Failed to delete subject %s", subject_id)
        raise HTTPException(status_code=500, detail="Failed to delete subject")
    finally:
        conn.close()


@app.delete("/users/{user_id}/clear-data")
def clear_user_data(user_id: int, _: None = Depends(require_service_secret)):
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM subjects WHERE user_id = %s", (user_id,))
            cur.execute("DELETE FROM timetable WHERE user_id = %s", (user_id,))
            conn.commit()

        return {"message": "All subjects and timetable data cleared successfully."}

    except Exception:
        logger.exception("Failed to clear data for user %s", user_id)
        raise HTTPException(status_code=500, detail="Failed to clear data")
    finally:
        conn.close()


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
                "period_no": int(item["period_no"]),
                "subject_name": item["subject_name"],
                "marked_status": None,
            }
            for item in today_classes
            if clean_text(item.get("subject_name"))
        ],
    }

    return dashboard, subjects


@app.get("/users/{user_id}/dashboard")
def get_dashboard(user_id: int, _: None = Depends(require_service_secret)):
    try:
        dashboard, _ = build_dashboard_payload(user_id)
        return dashboard
    except Exception:
        logger.exception("Failed to load dashboard for user %s", user_id)
        raise HTTPException(status_code=500, detail="Failed to load dashboard")


@app.get("/users/{user_id}/home-data")
def get_home_data(user_id: int, _: None = Depends(require_service_secret)):
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
        logger.exception("Failed to load home data for user %s", user_id)
        raise HTTPException(status_code=500, detail="Failed to load home data")


@app.post("/users/{user_id}/mark-attendance")
def mark_attendance(
    user_id: int,
    payload: MarkAttendance,
    _: None = Depends(require_service_secret),
):
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


@app.get("/users/{user_id}/schedule")
def get_schedule(user_id: int, _: None = Depends(require_service_secret)):
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
        logger.exception("Failed to fetch schedule for user %s", user_id)
        raise HTTPException(status_code=500, detail="Failed to fetch schedule")
    finally:
        conn.close()


@app.post("/users/{user_id}/schedule")
def save_schedule(
    user_id: int,
    payload: list[ScheduleEntry],
    _: None = Depends(require_service_secret),
):
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
        logger.exception("Failed to save schedule for user %s", user_id)
        raise HTTPException(status_code=500, detail="Failed to save schedule")
    finally:
        conn.close()


@app.get("/users/{user_id}/tomorrow")
def get_tomorrow(user_id: int, _: None = Depends(require_service_secret)):
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

    missed_classes = day_map.get(next_day_name, [])
    simulated = simulate_absence_for_subjects(subjects, missed_classes)

    return {
        "title": f"Next Class Day ({next_day_name})",
        "new_overall": round(simulated["new_overall"], 2),
        "drop_overall": round(current_overall - simulated["new_overall"], 2),
        "new_avg": round(simulated["new_avg"], 2),
        "drop_avg": round(current_avg - simulated["new_avg"], 2),
    }


@app.get("/users/{user_id}/best-day")
def get_best_day(user_id: int, _: None = Depends(require_service_secret)):
    return _day_logic(user_id, best=True)


@app.get("/users/{user_id}/worst-day")
def get_worst_day(user_id: int, _: None = Depends(require_service_secret)):
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
        missed_classes = day_map.get(day, [])

        if not missed_classes:
            continue

        simulated = simulate_absence_for_subjects(subjects, missed_classes)

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
                WEEKDAYS.index(r["day"]),
            ),
        )
        title = f"Best Day: {chosen['day']}"
    else:
        chosen = max(
            results,
            key=lambda r: (
                round(r["drop_overall"], 6),
                round(r["drop_avg"], 6),
                -WEEKDAYS.index(r["day"]),
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


@app.post("/users/{user_id}/plan-bunks")
def plan_bunks(
    user_id: int,
    payload: PlanPayload,
    _: None = Depends(require_service_secret),
):
    subjects = load_subjects_minimal(user_id)
    timetable_rows = load_timetable_rows(user_id)
    day_map = build_day_map(timetable_rows)

    current_overall = calc_overall(subjects)
    current_avg = calc_avg(subjects)

    missed_classes: list[dict[str, Any]] = []
    label = ""

    today = datetime.now(ZoneInfo("Asia/Kolkata")).date()

    if payload.mode == "tomorrow":
        next_day_name = get_next_valid_class_day(day_map)

        if next_day_name:
            missed_classes = day_map.get(next_day_name, [])
            label = f"Absent on {next_day_name}"
        else:
            label = "No upcoming classes"

    elif payload.mode == "next_n_days":
        n_days = payload.n_days or 1
        count = 0

        for i in range(1, 366):
            if count >= n_days:
                break

            check_date = today + timedelta(days=i)
            day_name = check_date.strftime("%A")
            classes = day_map.get(day_name, [])

            if any(clean_text(c.get("subject_name")) for c in classes):
                missed_classes.extend(classes)
                count += 1

        label = f"Absent for next {count} class days"

    elif payload.mode == "selected_weekdays":
        selected_days = payload.selected_days or []
        weeks = payload.weeks or 1

        valid_selected_days = [
            day for day in selected_days
            if day in WEEKDAYS
        ]

        for _ in range(weeks):
            for day_name in valid_selected_days:
                missed_classes.extend(day_map.get(day_name, []))

        label = "Absent on selected weekdays"

    simulated = simulate_absence_for_subjects(subjects, missed_classes)

    return {
        "scenario_label": label,
        "new_overall": round(simulated["new_overall"], 2),
        "drop_overall": round(current_overall - simulated["new_overall"], 2),
        "new_avg": round(simulated["new_avg"], 2),
        "drop_avg": round(current_avg - simulated["new_avg"], 2),
    }


@app.post("/users/{user_id}/calendar-plan")
def calendar_plan(
    user_id: int,
    payload: CalendarPlanPayload,
    _: None = Depends(require_service_secret),
):
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
                detail=f"Invalid date format: {day_plan.date}",
            )

        weekday_name = date_obj.strftime("%A")

        if weekday_name == "Sunday":
            skipped_dates.append({
                "date": day_plan.date,
                "reason": "No classes (Sunday)",
            })
            continue

        classes_today = day_map.get(weekday_name, [])

        if not classes_today or all(
            not clean_text(c.get("subject_name")) for c in classes_today
        ):
            skipped_dates.append({
                "date": day_plan.date,
                "reason": "No classes scheduled",
            })
            continue

        for class_item in classes_today:
            clean_class = clean_text(class_item.get("subject_name"))

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
