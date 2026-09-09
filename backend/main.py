from datetime import datetime, timedelta
from secrets import compare_digest
from typing import Any, Callable, Literal, Optional
from zoneinfo import ZoneInfo
import hashlib
import hmac
import logging
import math
import os
import re
import secrets
import threading
import time
from collections import defaultdict, deque

from database import get_conn
from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
import psycopg2
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, model_validator
import razorpay

from push_notifications import send_push_to_tokens
import crypto_util
import campushub

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
    """
    Deep health check used by the external keep-alive pinger.

    Runs a tiny `SELECT 1` so a single ping keeps BOTH the Render web
    service and the Supabase database from sleeping. Always returns HTTP
    200 (even if the DB is briefly unreachable) so the pinger keeps the
    web service warm regardless of transient DB hiccups.
    """
    db_ok = False
    try:
        conn = get_conn()
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT 1")
                cur.fetchone()
            db_ok = True
        finally:
            conn.close()
    except Exception:
        logger.exception("Health check DB ping failed")

    return {
        "status": "ok",
        "service": "bunkmax-api",
        "db": "ok" if db_ok else "down",
    }


def get_allowed_origins() -> list[str]:
    app_env = os.getenv("APP_ENV", "").strip().lower()
    allow_dev_origins = os.getenv("ALLOW_DEV_ORIGINS", "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }
    default_origins = ["https://bunk-max.vercel.app"]

    if app_env in {"development", "dev", "local", "test"} or allow_dev_origins:
        default_origins.extend([
            "http://localhost:3000",
            "http://localhost:3001",
            "http://127.0.0.1:3000",
            "http://127.0.0.1:3001",
        ])

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


# ---------------------------------------------------------------------------
# Lightweight in-memory rate limiting
#
# All real traffic reaches this backend from the Vercel proxy, so every
# request shares a small set of source IPs. Limiting per-IP would throttle
# every student as one client. Instead we key the limit on the user id in
# the request path (/users/{id}/...), which is exactly what stops a single
# student (or a runaway script) from hammering the API and exhausting the
# free-tier CPU / DB pool. Requests without a user id fall back to IP.
#
# State is per-process (per uvicorn worker). That is fine for basic abuse
# protection; it is a safety valve, not a billing meter.
# ---------------------------------------------------------------------------

def _get_int_env(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default


RATE_LIMIT_MAX = max(1, _get_int_env("RATE_LIMIT_MAX", 180))
RATE_LIMIT_WINDOW = max(1, _get_int_env("RATE_LIMIT_WINDOW", 60))
RATE_LIMIT_ENABLED = os.getenv("RATE_LIMIT_ENABLED", "true").strip().lower() not in {
    "0",
    "false",
    "no",
    "off",
}

# Paths that must never be rate limited (keep-alive pinger, root probe).
_RATE_LIMIT_EXEMPT_PATHS = {"/health", "/"}
_USER_ID_PATH_RE = re.compile(r"^/users/(\d+)")

_rate_lock = threading.Lock()
_rate_hits: dict[str, deque] = defaultdict(deque)


def _rate_limit_key(request: Request) -> str:
    match = _USER_ID_PATH_RE.match(request.url.path)
    if match:
        return f"u:{match.group(1)}"

    forwarded = request.headers.get("x-forwarded-for", "")
    client_ip = forwarded.split(",")[0].strip() if forwarded else ""
    if not client_ip and request.client:
        client_ip = request.client.host
    return f"ip:{client_ip or 'unknown'}"


@app.middleware("http")
async def rate_limit_middleware(request: Request, call_next):
    if (
        not RATE_LIMIT_ENABLED
        or request.method == "OPTIONS"
        or request.url.path in _RATE_LIMIT_EXEMPT_PATHS
    ):
        return await call_next(request)

    key = _rate_limit_key(request)
    now = time.monotonic()
    window_start = now - RATE_LIMIT_WINDOW

    with _rate_lock:
        hits = _rate_hits[key]
        while hits and hits[0] < window_start:
            hits.popleft()

        if len(hits) >= RATE_LIMIT_MAX:
            retry_after = max(1, int(RATE_LIMIT_WINDOW - (now - hits[0])))
            return JSONResponse(
                status_code=429,
                content={
                    "detail": "Too many requests. Please slow down and try again shortly."
                },
                headers={"Retry-After": str(retry_after)},
            )

        hits.append(now)

        # Opportunistic cleanup so idle keys don't accumulate forever.
        if len(_rate_hits) > 5000:
            for stale_key in [k for k, v in _rate_hits.items() if not v]:
                del _rate_hits[stale_key]

    return await call_next(request)


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


# ---------------------------------------------------------------------------
# Buddy invite codes
#
# Students pair up by sharing a short code, not by searching a directory.
# That keeps the user table non-enumerable: there is no endpoint that maps a
# name or roll number to a user id, so the only way to reach someone else's
# data is a code they chose to hand you.
#
# The alphabet drops 0/O/1/I/L so a code read off a phone screen and retyped
# into WhatsApp can't land on the wrong student.
# ---------------------------------------------------------------------------

BUDDY_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
BUDDY_CODE_LENGTH = 6
BUDDY_CODE_TTL = timedelta(hours=24)
BUDDY_MAX_PER_USER = 20


def generate_buddy_code() -> str:
    return "".join(secrets.choice(BUDDY_CODE_ALPHABET) for _ in range(BUDDY_CODE_LENGTH))


def normalize_buddy_code(raw: Any) -> str:
    """Uppercase and strip so 'ab c-d3f' and 'ABCD3F' resolve alike."""
    return re.sub(r"[^A-Z0-9]", "", clean_text(raw).upper())


class ERPImportPayload(BaseModel):
    subjects: list[dict[str, Any]]
    attendance: dict[str, Any]


class ERPSyncPayload(BaseModel):
    erp_username: str = Field(..., min_length=1, max_length=100)
    erp_password: str = Field(..., min_length=1, max_length=200)
    institute_slug: str = Field(default=campushub.DEFAULT_SLUG, max_length=100)
    save_credentials: bool = True


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



class CalendarPlanDay(BaseModel):
    date: str
    status: Literal["present", "absent"]


class CalendarPlanPayload(BaseModel):
    days: list[CalendarPlanDay]


class BuddyRedeemPayload(BaseModel):
    # Deliberately looser than the code itself: someone pasting "abc-123" or
    # "ABC 123" out of a chat should get normalised, not rejected. The exact
    # length is enforced after normalize_buddy_code() strips separators.
    code: str = Field(..., min_length=BUDDY_CODE_LENGTH, max_length=32)


class SubscriptionCheckoutPayload(BaseModel):
    plan_id: Literal["pro_3mo", "pro_6mo", "pro_monthly", "pro_yearly"]


class SubscriptionPaymentVerificationPayload(BaseModel):
    razorpay_payment_id: Optional[str] = Field(default=None, max_length=255)
    razorpay_order_id: Optional[str] = Field(default=None, max_length=255)
    razorpay_signature: Optional[str] = Field(default=None, max_length=1024)


class SubscriptionUpdatePayload(BaseModel):
    plan_id: Literal["free", "pro_3mo", "pro_6mo", "pro_monthly", "pro_yearly"] = "free"
    status: Literal["free", "active", "cancelled", "past_due", "expired"] = "free"
    renews_at: Optional[datetime] = None
    provider: str = Field(default="", max_length=80)
    reference: str = Field(default="", max_length=255)

    @model_validator(mode="after")
    def validate_subscription_update(self):
        self.plan_id = normalize_plan_id(self.plan_id)  # type: ignore[assignment]

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
        "id": "pro_3mo",
        "name": "Mid Plan",
        "price_rupees": 59,
        "billing_interval": "3 months",
        "description": "3 months of BunkMax access.",
        "features": [
            "Calendar-based bunk planning",
            "Smarter recovery targets",
            "Priority notification features",
            "Early access to student tools",
        ],
        "highlighted": False,
    },
    {
        "id": "pro_6mo",
        "name": "Semester Plan",
        "price_rupees": 89,
        "billing_interval": "6 months",
        "description": "Best value for one complete semester.",
        "features": [
            "Everything in the Mid Plan",
            "Lower semester price",
            "Semester-long planning support",
            "Priority feature requests",
        ],
        "highlighted": True,
    },
]

LEGACY_PLAN_ALIASES = {
    "pro_monthly": "pro_3mo",
    "pro_yearly": "pro_6mo",
}

PLAN_DURATIONS = {
    "pro_3mo": timedelta(days=92),
    "pro_6mo": timedelta(days=183),
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
            SET subscription_plan = 'pro_3mo'
            WHERE subscription_plan = 'pro_monthly';
        """,
        """
            UPDATE users
            SET subscription_plan = 'pro_6mo'
            WHERE subscription_plan = 'pro_yearly';
        """,
        """
            UPDATE users
            SET subscription_plan = 'free'
            WHERE subscription_plan IS NULL
               OR subscription_plan NOT IN ('free', 'pro_3mo', 'pro_6mo');
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


def normalize_plan_id(plan_id: Any) -> str:
    clean_plan_id = clean_text(plan_id) or "free"
    return LEGACY_PLAN_ALIASES.get(clean_plan_id, clean_plan_id)


def get_subscription_plan(plan_id: str) -> dict[str, Any]:
    plan_id = normalize_plan_id(plan_id)

    if plan_id == "free":
        return FREE_SUBSCRIPTION_PLAN

    for plan in SUBSCRIPTION_PLANS:
        if plan["id"] == plan_id:
            return plan

    raise HTTPException(status_code=400, detail="Invalid subscription plan")


def subscription_payment_link(plan_id: str) -> str:
    plan_id = normalize_plan_id(plan_id)
    plan_key = plan_id.upper()
    legacy_plan_key = next(
        (
            legacy_id.upper()
            for legacy_id, canonical_id in LEGACY_PLAN_ALIASES.items()
            if canonical_id == plan_id
        ),
        "",
    )

    return (
        os.getenv(f"SUBSCRIPTION_{plan_key}_URL", "").strip()
        or os.getenv(f"RAZORPAY_{plan_key}_LINK", "").strip()
        or (
            os.getenv(f"SUBSCRIPTION_{legacy_plan_key}_URL", "").strip()
            if legacy_plan_key else ""
        )
        or (
            os.getenv(f"RAZORPAY_{legacy_plan_key}_LINK", "").strip()
            if legacy_plan_key else ""
        )
    )


def is_subscription_active(row: dict[str, Any]) -> bool:
    plan_id = normalize_plan_id(row.get("subscription_plan"))
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
    plan_id = normalize_plan_id(user.get("subscription_plan"))
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


def expected_plan_amount_paise(plan: dict[str, Any]) -> int:
    return int(plan["price_rupees"]) * 100


def validate_razorpay_money(
    entity: dict[str, Any],
    plan: dict[str, Any],
    *,
    amount_field: str = "amount",
) -> None:
    amount_paise = expected_plan_amount_paise(plan)

    if int(entity.get(amount_field) or 0) != amount_paise:
        raise HTTPException(status_code=400, detail="Payment amount mismatch")

    if clean_text(entity.get("currency")).upper() != "INR":
        raise HTTPException(status_code=400, detail="Payment currency mismatch")


def validate_captured_razorpay_payment(
    payment_id: str,
    plan: dict[str, Any],
) -> dict[str, Any]:
    if not razorpay_client:
        raise HTTPException(
            status_code=500,
            detail="Razorpay is not configured on the server.",
        )

    try:
        payment = razorpay_client.payment.fetch(payment_id)
    except (
        razorpay.errors.BadRequestError,
        razorpay.errors.GatewayError,
        razorpay.errors.ServerError,
    ) as exc:
        raise razorpay_error_response(exc, "Failed to verify Razorpay payment")

    if clean_text(payment.get("status")).lower() != "captured":
        raise HTTPException(status_code=400, detail="Payment is not captured")

    validate_razorpay_money(payment, plan)
    return payment


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
                "token_user_ids": {},
            },
        )

        group["tokens"].append(token)
        group["user_ids"].add(user_id)
        group["token_user_ids"][token] = user_id

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

        success_tokens = {
            clean_text(token)
            for token in result.get("success_tokens", [])
            if clean_text(token)
        }
        successful_user_ids = {
            group["token_user_ids"][token]
            for token in success_tokens
            if token in group["token_user_ids"]
        }

        logged_user_ids.update(successful_user_ids)
        mark_notifications_sent(successful_user_ids, notification_type, sent_date)

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
                CREATE TABLE IF NOT EXISTS erp_credentials (
                    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                    erp_username TEXT NOT NULL,
                    erp_password_enc TEXT NOT NULL,
                    institute_slug TEXT DEFAULT 'mlrit-hyderabad',
                    last_synced_at TIMESTAMPTZ,
                    last_sync_status TEXT DEFAULT '',
                    created_at TIMESTAMPTZ DEFAULT NOW(),
                    updated_at TIMESTAMPTZ DEFAULT NOW()
                );
            """)

            cur.execute("""
                CREATE TABLE IF NOT EXISTS buddies (
                    id SERIAL PRIMARY KEY,
                    user_a INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    user_b INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    created_at TIMESTAMPTZ DEFAULT NOW(),
                    CONSTRAINT buddies_distinct CHECK (user_a <> user_b),
                    CONSTRAINT buddies_ordered CHECK (user_a < user_b),
                    UNIQUE (user_a, user_b)
                );
            """)

            cur.execute("""
                CREATE TABLE IF NOT EXISTS buddy_invites (
                    code TEXT PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    created_at TIMESTAMPTZ DEFAULT NOW(),
                    expires_at TIMESTAMPTZ NOT NULL,
                    redeemed_by INTEGER REFERENCES users(id) ON DELETE CASCADE,
                    redeemed_at TIMESTAMPTZ
                );
            """)

            cur.execute("""
                CREATE INDEX IF NOT EXISTS idx_buddies_user_b
                ON buddies(user_b);
            """)

            cur.execute("""
                CREATE INDEX IF NOT EXISTS idx_buddy_invites_user_id
                ON buddy_invites(user_id);
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
                SET subscription_plan = 'pro_3mo'
                WHERE subscription_plan = 'pro_monthly';
            """)

            cur.execute("""
                UPDATE users
                SET subscription_plan = 'pro_6mo'
                WHERE subscription_plan = 'pro_yearly';
            """)

            cur.execute("""
                UPDATE users
                SET subscription_plan = 'free'
                WHERE subscription_plan IS NULL
                   OR subscription_plan NOT IN ('free', 'pro_3mo', 'pro_6mo');
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
                CREATE TABLE IF NOT EXISTS erp_credentials (
                    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                    erp_username TEXT NOT NULL,
                    erp_password_enc TEXT NOT NULL,
                    institute_slug TEXT DEFAULT 'mlrit-hyderabad',
                    last_synced_at TIMESTAMPTZ,
                    last_sync_status TEXT DEFAULT '',
                    created_at TIMESTAMPTZ DEFAULT NOW(),
                    updated_at TIMESTAMPTZ DEFAULT NOW()
                );
            """)

            cur.execute("""
                CREATE TABLE IF NOT EXISTS buddies (
                    id SERIAL PRIMARY KEY,
                    user_a INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    user_b INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    created_at TIMESTAMPTZ DEFAULT NOW(),
                    CONSTRAINT buddies_distinct CHECK (user_a <> user_b),
                    CONSTRAINT buddies_ordered CHECK (user_a < user_b),
                    UNIQUE (user_a, user_b)
                );
            """)

            cur.execute("""
                CREATE TABLE IF NOT EXISTS buddy_invites (
                    code TEXT PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    created_at TIMESTAMPTZ DEFAULT NOW(),
                    expires_at TIMESTAMPTZ NOT NULL,
                    redeemed_by INTEGER REFERENCES users(id) ON DELETE CASCADE,
                    redeemed_at TIMESTAMPTZ
                );
            """)

            cur.execute("""
                CREATE INDEX IF NOT EXISTS idx_buddies_user_b
                ON buddies(user_b);
            """)

            cur.execute("""
                CREATE INDEX IF NOT EXISTS idx_buddy_invites_user_id
                ON buddy_invites(user_id);
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


def is_allowed_login_email(email: str) -> bool:
    """
    Real students are @mlrit.ac.in, full stop.

    DEV_ALLOWED_EMAILS punches a hole for test accounts, but ONLY when
    APP_ENV says this is a development box — the same switch get_allowed_origins
    uses. On Render, APP_ENV is unset/production, so the variable is inert even
    if it somehow ends up configured there.
    """
    if email.endswith("@mlrit.ac.in"):
        return True

    app_env = os.getenv("APP_ENV", "").strip().lower()

    if app_env not in {"development", "dev", "local", "test"}:
        return False

    allowed = {
        entry.strip().lower()
        for entry in os.getenv("DEV_ALLOWED_EMAILS", "").split(",")
        if entry.strip()
    }

    if email in allowed:
        logger.warning("Dev-only login allowed for non-MLRIT account: %s", email)
        return True

    return False


@app.post("/auth/google-user")
def auth_google_user(
    payload: GoogleUserPayload,
    _: None = Depends(require_service_secret),
):
    email = clean_text(payload.email).lower()
    name = clean_text(payload.name) or "Student"

    if not is_allowed_login_email(email):
        raise HTTPException(status_code=403, detail="Only MLRIT accounts allowed")

    conn = get_conn()
    try:
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
        plan_id = normalize_plan_id(payload.plan_id)
        plan = get_subscription_plan(plan_id)
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
                "plan_id": plan_id,
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

    plan_id = normalize_plan_id(plan_id)
    plan = get_subscription_plan(plan_id)
    validate_razorpay_money(order, plan)
    payment = validate_captured_razorpay_payment(payment_id, plan)

    conn = get_conn()
    try:
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
            """, (plan_id, renews_at, clean_text(payment.get("id")) or payment_id, user_id))
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
            plan_id = normalize_plan_id(plan_id)
            plan = get_subscription_plan(plan_id)
            amount_field = "amount_paid" if entity.get("amount_paid") is not None else "amount"
            validate_razorpay_money(entity, plan, amount_field=amount_field)

            payment_entity = data.get("payload", {}).get("payment", {}).get("entity", {})
            if payment_entity:
                if clean_text(payment_entity.get("status")).lower() != "captured":
                    return {"status": "ok", "message": "Ignored - payment not captured"}

                validate_razorpay_money(payment_entity, plan)
                reference = clean_text(payment_entity.get("id")) or reference

            # Update database
            conn = get_conn()
            try:
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
        plan_id = normalize_plan_id(payload.plan_id)

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
                plan_id,
                payload.status,
                plan_id,
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


def _upsert_erp_subjects(cur, user_id, subjects, attendance) -> int:
    """
    Upsert ERP-shaped attendance into the subjects table using an open cursor.

    Shared by the copy-paste importer and the server-side portal sync. Expects
    `subjects` as [{subjectid, subject_name}] and `attendance` as
    {subjectid: {totalsessions, presentSessionsCount, percentage}}.
    Returns the count written.
    """
    imported = 0

    for subject in subjects:
        subject_id = clean_text(subject.get("subjectid"))
        subject_name = clean_text(subject.get("subject_name"))

        if not subject_id or not subject_name:
            continue

        stats = attendance.get(subject_id, {}) or {}

        try:
            total = int(stats.get("totalsessions", 0) or 0)
            present = int(stats.get("presentSessionsCount", 0) or 0)
        except Exception:
            continue

        if total < 0 or present < 0:
            continue

        if present > total:
            present = total

        # Use the percentage from the payload to derive required_percentage,
        # falling back to 75 when the importer didn't supply one.
        try:
            pct = float(stats.get("percentage") or 0)
            required_percentage = int(pct) if pct > 0 else 75
        except (TypeError, ValueError):
            required_percentage = 75

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
            required_percentage,
        ))

        imported += 1

    return imported


def _upsert_timetable(cur, user_id, entries) -> int:
    """
    Replace the user's weekly timetable with `entries` using an open cursor.

    Expects [{day_name, period_no, subject_name}]. Destructive on purpose: the
    portal timetable is authoritative, so stale slots (a subject that moved or
    was dropped) must disappear rather than linger. A no-op when `entries` is
    empty, so a portal hiccup can never wipe a saved timetable.
    """
    rows = []
    for entry in entries or []:
        day_name = clean_text(entry.get("day_name"))
        subject_name = clean_text(entry.get("subject_name"))
        try:
            period_no = int(entry.get("period_no") or 0)
        except (TypeError, ValueError):
            continue
        if day_name not in VALID_DAYS or not subject_name:
            continue
        if period_no < 1 or period_no > CLASS_PERIODS:
            continue
        rows.append((user_id, day_name, period_no, subject_name))

    if not rows:
        return 0

    cur.execute("DELETE FROM timetable WHERE user_id = %s", (user_id,))
    cur.executemany("""
        INSERT INTO timetable (user_id, day_name, period_no, subject_name)
        VALUES (%s, %s, %s, %s)
        ON CONFLICT (user_id, day_name, period_no)
        DO UPDATE SET subject_name = EXCLUDED.subject_name
    """, rows)
    return len(rows)


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
            imported = _upsert_erp_subjects(
                cur, user_id, payload.subjects, payload.attendance
            )
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


# ─────────────────────────── ERP portal sync ───────────────────────────
# Server-side login to the college portal (CampusHub) so students don't have
# to copy-paste. Credentials can optionally be stored (Fernet-encrypted) for
# one-tap re-sync and the daily auto-sync cron.

def _ensure_erp_credentials_table(cur) -> None:
    cur.execute("""
        CREATE TABLE IF NOT EXISTS erp_credentials (
            user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            erp_username TEXT NOT NULL,
            erp_password_enc TEXT NOT NULL,
            institute_slug TEXT DEFAULT 'mlrit-hyderabad',
            last_synced_at TIMESTAMPTZ,
            last_sync_status TEXT DEFAULT '',
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
        );
    """)


def _run_erp_sync(user_id: int, username: str, password: str, slug: str,
                  *, save_credentials: bool) -> dict:
    """Fetch from the portal, upsert subjects + timetable, optionally persist credentials."""
    result = campushub.fetch_all(username, password, slug)
    subjects = result["subjects"]
    attendance = result["attendance"]
    timetable = result.get("timetable") or []

    conn = get_conn()
    try:
        with conn.cursor() as cur:
            imported = _upsert_erp_subjects(cur, user_id, subjects, attendance)
            periods_imported = _upsert_timetable(cur, user_id, timetable)

            if save_credentials:
                _ensure_erp_credentials_table(cur)
                cur.execute("""
                    INSERT INTO erp_credentials (
                        user_id, erp_username, erp_password_enc, institute_slug,
                        last_synced_at, last_sync_status, updated_at
                    )
                    VALUES (%s, %s, %s, %s, NOW(), %s, NOW())
                    ON CONFLICT (user_id) DO UPDATE SET
                        erp_username = EXCLUDED.erp_username,
                        erp_password_enc = EXCLUDED.erp_password_enc,
                        institute_slug = EXCLUDED.institute_slug,
                        last_synced_at = NOW(),
                        last_sync_status = EXCLUDED.last_sync_status,
                        updated_at = NOW()
                """, (
                    user_id,
                    username.strip(),
                    crypto_util.encrypt(password),
                    slug,
                    "ok",
                ))
            else:
                # If they previously saved but now opt out, still refresh the
                # last_synced marker when a row exists.
                _ensure_erp_credentials_table(cur)
                cur.execute(
                    "UPDATE erp_credentials SET last_synced_at = NOW(), "
                    "last_sync_status = 'ok', updated_at = NOW() WHERE user_id = %s",
                    (user_id,),
                )

            conn.commit()
    finally:
        conn.close()

    if imported:
        message = f"{imported} subjects synced from the portal."
    else:
        message = "Signed in, but no attendance found yet (no classes conducted)."
    if periods_imported:
        message += f" Timetable synced ({periods_imported} periods)."

    return {
        "message": message,
        "subjects_imported": imported,
        "periods_imported": periods_imported,
        "timetable_conflicts": result.get("timetable_conflicts") or [],
        "average": result.get("average", 0),
        "student": result.get("student", {}),
        "credentials_saved": save_credentials,
    }


@app.post("/users/{user_id}/erp-sync")
def erp_sync(
    user_id: int,
    payload: ERPSyncPayload,
    _: None = Depends(require_service_secret),
):
    # Saving the password is a convenience on top of the sync, not a
    # precondition for it. When ERP_CRED_KEY is missing we still sync and just
    # report that the login could not be kept, rather than failing a request
    # that would otherwise have succeeded.
    save_credentials = payload.save_credentials and crypto_util.is_configured()
    degraded = payload.save_credentials and not save_credentials
    if degraded:
        logger.warning(
            "ERP_CRED_KEY not configured; syncing user %s without saving credentials",
            user_id,
        )
    try:
        result = _run_erp_sync(
            user_id,
            payload.erp_username,
            payload.erp_password,
            payload.institute_slug or campushub.DEFAULT_SLUG,
            save_credentials=save_credentials,
        )
        if degraded:
            result["credentials_error"] = (
                "Your attendance synced, but the login could not be saved for "
                "auto-sync (server-side encrypted storage is not configured)."
            )
        return result
    except campushub.ERPError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.message)
    except crypto_util.CredentialCryptoError:
        logger.exception("ERP credential encryption failed for user %s", user_id)
        raise HTTPException(status_code=500, detail="Could not securely store credentials.")
    except HTTPException:
        raise
    except Exception:
        logger.exception("ERP sync failed for user %s", user_id)
        raise HTTPException(status_code=500, detail="Portal sync failed.")


@app.post("/users/{user_id}/erp-resync")
def erp_resync(user_id: int, _: None = Depends(require_service_secret)):
    """Re-sync using stored credentials — no password in the request."""
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            _ensure_erp_credentials_table(cur)
            cur.execute(
                "SELECT erp_username, erp_password_enc, institute_slug "
                "FROM erp_credentials WHERE user_id = %s",
                (user_id,),
            )
            row = cur.fetchone()
            conn.commit()
    finally:
        conn.close()

    if not row:
        raise HTTPException(status_code=404, detail="No saved portal login found.")

    try:
        password = crypto_util.decrypt(row["erp_password_enc"])
    except crypto_util.CredentialCryptoError:
        logger.exception("Could not decrypt ERP credentials for user %s", user_id)
        raise HTTPException(
            status_code=409,
            detail="Saved login could not be read. Please sign in again.",
        )

    try:
        return _run_erp_sync(
            user_id,
            row["erp_username"],
            password,
            row.get("institute_slug") or campushub.DEFAULT_SLUG,
            save_credentials=True,
        )
    except campushub.ERPError as exc:
        _mark_erp_sync_status(user_id, f"error: {exc.message}"[:200])
        raise HTTPException(status_code=exc.status, detail=exc.message)
    except HTTPException:
        raise
    except Exception:
        logger.exception("ERP resync failed for user %s", user_id)
        raise HTTPException(status_code=500, detail="Portal sync failed.")


def _mark_erp_sync_status(user_id: int, status: str) -> None:
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            _ensure_erp_credentials_table(cur)
            cur.execute(
                "UPDATE erp_credentials SET last_sync_status = %s, updated_at = NOW() "
                "WHERE user_id = %s",
                (status, user_id),
            )
            conn.commit()
    except Exception:
        logger.exception("Failed to record ERP sync status for user %s", user_id)
    finally:
        conn.close()


@app.get("/users/{user_id}/erp-status")
def erp_status(user_id: int, _: None = Depends(require_service_secret)):
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            _ensure_erp_credentials_table(cur)
            cur.execute(
                "SELECT erp_username, institute_slug, last_synced_at, last_sync_status "
                "FROM erp_credentials WHERE user_id = %s",
                (user_id,),
            )
            row = cur.fetchone()
            conn.commit()
    finally:
        conn.close()

    # Lets /import tell students up front whether "Keep me synced" can work.
    crypto_available = crypto_util.is_configured()

    if not row:
        return {"saved": False, "crypto_available": crypto_available}

    last_synced = row.get("last_synced_at")
    return {
        "saved": True,
        "crypto_available": crypto_available,
        "erp_username": row.get("erp_username"),
        "institute_slug": row.get("institute_slug"),
        "last_synced_at": last_synced.isoformat() if last_synced else None,
        "last_sync_status": row.get("last_sync_status") or "",
    }


@app.delete("/users/{user_id}/erp-credentials")
def delete_erp_credentials(user_id: int, _: None = Depends(require_service_secret)):
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            _ensure_erp_credentials_table(cur)
            cur.execute("DELETE FROM erp_credentials WHERE user_id = %s", (user_id,))
            conn.commit()
    finally:
        conn.close()
    return {"message": "Saved portal login removed."}


@app.get("/cron/erp/sync-all")
@app.post("/cron/erp/sync-all")
def cron_erp_sync_all(_: None = Depends(require_notification_cron_secret)):
    """Daily best-effort re-sync of every student with saved credentials."""
    if not crypto_util.is_configured():
        raise HTTPException(status_code=500, detail="Credential storage not configured.")

    conn = get_conn()
    try:
        with conn.cursor() as cur:
            _ensure_erp_credentials_table(cur)
            cur.execute(
                "SELECT user_id, erp_username, erp_password_enc, institute_slug "
                "FROM erp_credentials"
            )
            rows = cur.fetchall()
            conn.commit()
    finally:
        conn.close()

    synced = 0
    failed = 0
    for row in rows:
        uid = row["user_id"]
        try:
            password = crypto_util.decrypt(row["erp_password_enc"])
            _run_erp_sync(
                uid,
                row["erp_username"],
                password,
                row.get("institute_slug") or campushub.DEFAULT_SLUG,
                save_credentials=True,
            )
            synced += 1
        except campushub.ERPError as exc:
            failed += 1
            _mark_erp_sync_status(uid, f"error: {exc.message}"[:200])
        except Exception:
            failed += 1
            logger.exception("Cron ERP sync failed for user %s", uid)
            _mark_erp_sync_status(uid, "error: sync failed")

    return {"synced": synced, "failed": failed, "total": len(rows)}


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

    return dashboard, subjects, day_map



@app.get("/users/{user_id}/home-data")
def get_home_data(user_id: int, _: None = Depends(require_service_secret)):
    try:
        dashboard, subjects, day_map = build_dashboard_payload(user_id)

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
            "tomorrow": compute_tomorrow(subjects, day_map),
            "best_day": compute_day_logic(subjects, day_map, best=True),
            "worst_day": compute_day_logic(subjects, day_map, best=False),
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
                ORDER BY
                    CASE WHEN subject_name = %s THEN 0 ELSE 1 END,
                    id
                LIMIT 1
            """, (
                user_id,
                payload.subject_name.strip(),
                payload.subject_name.strip(),
            ))

            subject = cur.fetchone()

            if not subject:
                raise HTTPException(status_code=404, detail="Subject not found")

            if payload.status == "present":
                cur.execute("""
                    UPDATE subjects
                    SET attended_classes = attended_classes + 1,
                        total_classes = total_classes + 1
                    WHERE id = %s AND user_id = %s
                """, (subject["id"], user_id))
            else:
                cur.execute("""
                    UPDATE subjects
                    SET total_classes = total_classes + 1
                    WHERE id = %s AND user_id = %s
                """, (subject["id"], user_id))

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


def compute_tomorrow(
    subjects: list[dict[str, Any]],
    day_map: dict[str, list[dict[str, Any]]],
):
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


def compute_day_logic(
    subjects: list[dict[str, Any]],
    day_map: dict[str, list[dict[str, Any]]],
    best: bool,
):
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



@app.post("/users/{user_id}/calendar-plan")
def calendar_plan(
    user_id: int,
    payload: CalendarPlanPayload,
    _: None = Depends(require_service_secret),
):
    if not payload.days:
        raise HTTPException(status_code=400, detail="At least one date is required")

    today = datetime.now(ZoneInfo("Asia/Kolkata")).date()
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

        if date_obj < today:
            raise HTTPException(
                status_code=400,
                detail=f"Past dates cannot be planned: {day_plan.date}",
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


# ---------------------------------------------------------------------------
# Buddy
#
# Two students pair up with a single-use invite code, then ask "which day can
# we BOTH afford to bunk?".
#
# Load shape matters here. The single-user loaders each check a connection out
# of the pool (DB_POOL_MAX=10 on one uvicorn worker), so the obvious two-user
# implementation would take four checkouts per request. Everything below runs
# on ONE connection and pulls both students in one query per table via
# `user_id = ANY(...)`, which makes a buddy request cheaper than /home-data.
# ---------------------------------------------------------------------------


def load_subjects_for_users(
    conn,
    user_ids: list[int],
) -> dict[int, list[dict[str, Any]]]:
    """Both students' subjects in one query, grouped by user id."""
    grouped: dict[int, list[dict[str, Any]]] = {uid: [] for uid in user_ids}

    with conn.cursor() as cur:
        cur.execute("""
            SELECT user_id, subject_name, attended_classes, total_classes
            FROM subjects
            WHERE user_id = ANY(%s)
            ORDER BY user_id, subject_name
        """, (user_ids,))

        for row in cur.fetchall():
            grouped.setdefault(int(row["user_id"]), []).append(row)

    return grouped


def load_timetables_for_users(
    conn,
    user_ids: list[int],
) -> dict[int, dict[str, list[dict[str, Any]]]]:
    """Both students' day maps in one query, grouped by user id."""
    rows_by_user: dict[int, list[dict[str, Any]]] = {uid: [] for uid in user_ids}

    with conn.cursor() as cur:
        cur.execute("""
            SELECT user_id, day_name, period_no, subject_name
            FROM timetable
            WHERE user_id = ANY(%s)
              AND subject_name IS NOT NULL
              AND TRIM(subject_name) != ''
            ORDER BY user_id, period_no
        """, (user_ids,))

        for row in cur.fetchall():
            rows_by_user.setdefault(int(row["user_id"]), []).append(row)

    return {uid: build_day_map(rows) for uid, rows in rows_by_user.items()}


def buddy_pair(user_id: int, buddy_id: int) -> tuple[int, int]:
    """
    Canonical (low, high) ordering.

    Friendship is symmetric, so storing it ordered means one row per pair and
    the UNIQUE(user_a, user_b) constraint does the deduplication for us — no
    "A added B and B added A" double rows to reconcile later.
    """
    return (min(user_id, buddy_id), max(user_id, buddy_id))


_buddy_tables_lock = threading.Lock()
_buddy_tables_ready = False


def _ensure_buddy_tables(conn) -> None:
    """
    Create the buddy tables on first use, the way `erp_credentials` does.

    They are also in /init-db, but that route sits behind
    ENABLE_ADMIN_DB_ROUTES and 404s unless someone flips the flag by hand, so
    a deploy that ships a new table leaves these endpoints querying a relation
    that does not exist -- every call erroring, and every error landing in the
    Postgres log. Committing immediately (rather than riding the caller's
    transaction) means a later rollback in the endpoint cannot undo the DDL
    while leaving the latch set. Latched after the first success, so this
    costs one bool check per request instead of four DDL statements.
    """
    global _buddy_tables_ready

    if _buddy_tables_ready:
        return

    with _buddy_tables_lock:
        if _buddy_tables_ready:
            return

        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS buddies (
                    id SERIAL PRIMARY KEY,
                    user_a INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    user_b INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    created_at TIMESTAMPTZ DEFAULT NOW(),
                    CONSTRAINT buddies_distinct CHECK (user_a <> user_b),
                    CONSTRAINT buddies_ordered CHECK (user_a < user_b),
                    UNIQUE (user_a, user_b)
                );
            """)

            cur.execute("""
                CREATE TABLE IF NOT EXISTS buddy_invites (
                    code TEXT PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    created_at TIMESTAMPTZ DEFAULT NOW(),
                    expires_at TIMESTAMPTZ NOT NULL,
                    redeemed_by INTEGER REFERENCES users(id) ON DELETE CASCADE,
                    redeemed_at TIMESTAMPTZ
                );
            """)

            cur.execute("""
                CREATE INDEX IF NOT EXISTS idx_buddies_user_b
                ON buddies(user_b);
            """)

            cur.execute("""
                CREATE INDEX IF NOT EXISTS idx_buddy_invites_user_id
                ON buddy_invites(user_id);
            """)

        conn.commit()
        _buddy_tables_ready = True


def fetch_buddy(conn, user_id: int, buddy_id: int) -> Optional[dict[str, Any]]:
    """
    Return the buddy's public identity, but only if the pair is actually
    linked. Every endpoint that reads another student's attendance goes
    through this first — the proxy proves who the CALLER is, and this proves
    they're allowed to see the person they're asking about.
    """
    low, high = buddy_pair(user_id, buddy_id)

    with conn.cursor() as cur:
        cur.execute("""
            SELECT u.id, u.name, u.email
            FROM buddies b
            JOIN users u ON u.id = %s
            WHERE b.user_a = %s AND b.user_b = %s
        """, (buddy_id, low, high))

        return cur.fetchone()


def count_buddies(cur, user_id: int) -> int:
    cur.execute("""
        SELECT COUNT(*) AS n
        FROM buddies
        WHERE user_a = %s OR user_b = %s
    """, (user_id, user_id))

    row = cur.fetchone()
    return int(row["n"]) if row else 0


def describe_missed(classes: list[dict[str, Any]]) -> list[str]:
    """Distinct subject names for a day, in period order."""
    seen: list[str] = []

    for item in classes:
        name = clean_text(item.get("subject_name"))
        if name and name not in seen:
            seen.append(name)

    return seen


def build_buddy_day(
    day: str,
    my_subjects: list[dict[str, Any]],
    my_classes: list[dict[str, Any]],
    my_overall: float,
    buddy_subjects: list[dict[str, Any]],
    buddy_classes: list[dict[str, Any]],
    buddy_overall: float,
) -> dict[str, Any]:
    my_sim = simulate_absence_for_subjects(my_subjects, my_classes)
    buddy_sim = simulate_absence_for_subjects(buddy_subjects, buddy_classes)

    my_drop = my_overall - my_sim["new_overall"]
    buddy_drop = buddy_overall - buddy_sim["new_overall"]

    return {
        "day": day,
        "you": {
            "new_overall": round(my_sim["new_overall"], 2),
            "drop_overall": round(my_drop, 2),
            "classes_missed": len(my_classes),
            "subjects_missed": describe_missed(my_classes),
        },
        "buddy": {
            "new_overall": round(buddy_sim["new_overall"], 2),
            "drop_overall": round(buddy_drop, 2),
            "classes_missed": len(buddy_classes),
            "subjects_missed": describe_missed(buddy_classes),
        },
        # Ranking keys, kept unrounded so near-ties order deterministically.
        "_worst_drop": max(my_drop, buddy_drop),
        "_total_drop": my_drop + buddy_drop,
    }


def compute_buddy_week(
    my_subjects: list[dict[str, Any]],
    my_day_map: dict[str, list[dict[str, Any]]],
    buddy_subjects: list[dict[str, Any]],
    buddy_day_map: dict[str, list[dict[str, Any]]],
) -> dict[str, Any]:
    """
    Rank the week by the WORSE of the two students' attendance drops.

    Summing the two drops would happily recommend a day that costs one of you
    almost nothing and the other 4% — which is not a day you'd actually bunk
    together. Minimising the worst case picks the day that's genuinely safe
    for both, and total drop only breaks ties.
    """
    my_overall = calc_overall(my_subjects)
    buddy_overall = calc_overall(buddy_subjects)

    days = [
        build_buddy_day(
            day,
            my_subjects,
            my_day_map.get(day, []),
            my_overall,
            buddy_subjects,
            buddy_day_map.get(day, []),
            buddy_overall,
        )
        for day in WEEKDAYS
        if my_day_map.get(day) or buddy_day_map.get(day)
    ]

    result: dict[str, Any] = {
        "current": {
            "you": round(my_overall, 2),
            "buddy": round(buddy_overall, 2),
        },
        "days": [],
        "best_day": None,
        "worst_day": None,
    }

    if not days:
        return result

    def rank_key(entry: dict[str, Any]):
        return (
            round(entry["_worst_drop"], 6),
            round(entry["_total_drop"], 6),
            WEEKDAYS.index(entry["day"]),
        )

    best = min(days, key=rank_key)
    worst = max(days, key=rank_key)

    for entry in days:
        entry["worst_drop"] = round(entry["_worst_drop"], 2)
        entry["total_drop"] = round(entry["_total_drop"], 2)
        entry["is_best"] = entry["day"] == best["day"]
        del entry["_worst_drop"]
        del entry["_total_drop"]

    result["days"] = days
    result["best_day"] = best["day"]
    result["worst_day"] = worst["day"]

    return result


@app.post("/users/{user_id}/buddy-invite")
def create_buddy_invite(user_id: int, _: None = Depends(require_service_secret)):
    """
    Mint a fresh single-use code, retiring any the student hasn't spent yet.

    Rotating on every call means a code pasted into the wrong group chat stops
    working as soon as they generate a new one.
    """
    conn = get_conn()
    try:
        _ensure_buddy_tables(conn)

        with conn.cursor() as cur:
            if count_buddies(cur, user_id) >= BUDDY_MAX_PER_USER:
                raise HTTPException(
                    status_code=400,
                    detail=f"You can have at most {BUDDY_MAX_PER_USER} buddies.",
                )

            expires_at = datetime.now(ZoneInfo("UTC")) + BUDDY_CODE_TTL

            # Retry on the astronomically unlikely primary-key collision
            # rather than letting a 500 reach the student. The savepoint keeps
            # a failed attempt from rolling back the whole transaction — a
            # plain rollback here would also undo the rotation below.
            for _attempt in range(5):
                code = generate_buddy_code()

                cur.execute("SAVEPOINT mint_code")

                try:
                    cur.execute("""
                        INSERT INTO buddy_invites (code, user_id, expires_at)
                        VALUES (%s, %s, %s)
                    """, (code, user_id, expires_at))
                    cur.execute("RELEASE SAVEPOINT mint_code")
                    break
                except psycopg2.IntegrityError:
                    cur.execute("ROLLBACK TO SAVEPOINT mint_code")
                    continue
            else:
                raise HTTPException(
                    status_code=500,
                    detail="Could not generate an invite code. Please try again.",
                )

            # Retire any code they hadn't spent yet, so a code pasted into the
            # wrong group chat stops working once they generate a new one.
            cur.execute("""
                DELETE FROM buddy_invites
                WHERE user_id = %s AND redeemed_by IS NULL AND code <> %s
            """, (user_id, code))

            conn.commit()

        return {
            "code": code,
            "expires_at": expires_at.isoformat(),
            "expires_in_hours": int(BUDDY_CODE_TTL.total_seconds() // 3600),
        }

    except HTTPException:
        conn.rollback()
        raise
    except Exception:
        conn.rollback()
        logger.exception("Failed to create buddy invite for user %s", user_id)
        raise HTTPException(status_code=500, detail="Failed to create invite code")
    finally:
        conn.close()


@app.get("/users/{user_id}/buddies")
def list_buddies(user_id: int, _: None = Depends(require_service_secret)):
    conn = get_conn()
    try:
        _ensure_buddy_tables(conn)

        with conn.cursor() as cur:
            cur.execute("""
                SELECT
                    u.id,
                    u.name,
                    u.email,
                    b.created_at
                FROM buddies b
                JOIN users u
                  ON u.id = CASE WHEN b.user_a = %s THEN b.user_b ELSE b.user_a END
                WHERE b.user_a = %s OR b.user_b = %s
                ORDER BY u.name, u.id
            """, (user_id, user_id, user_id))

            buddies = [
                {
                    "id": int(row["id"]),
                    "name": clean_text(row["name"]) or "Student",
                    "email": clean_text(row["email"]),
                    "since": row["created_at"].isoformat() if row["created_at"] else None,
                }
                for row in cur.fetchall()
            ]

            cur.execute("""
                SELECT code, expires_at
                FROM buddy_invites
                WHERE user_id = %s
                  AND redeemed_by IS NULL
                  AND expires_at > NOW()
                ORDER BY created_at DESC
                LIMIT 1
            """, (user_id,))

            invite_row = cur.fetchone()

        return {
            "buddies": buddies,
            "max_buddies": BUDDY_MAX_PER_USER,
            "invite": {
                "code": invite_row["code"],
                "expires_at": invite_row["expires_at"].isoformat(),
            } if invite_row else None,
        }

    except Exception:
        logger.exception("Failed to list buddies for user %s", user_id)
        raise HTTPException(status_code=500, detail="Failed to load buddies")
    finally:
        conn.close()


@app.post("/users/{user_id}/buddies")
def redeem_buddy_invite(
    user_id: int,
    payload: BuddyRedeemPayload,
    _: None = Depends(require_service_secret),
):
    code = normalize_buddy_code(payload.code)

    if len(code) != BUDDY_CODE_LENGTH:
        raise HTTPException(status_code=400, detail="That code doesn't look right.")

    conn = get_conn()
    try:
        _ensure_buddy_tables(conn)

        with conn.cursor() as cur:
            # Lock the invite row so two people racing the same code can't
            # both redeem it.
            cur.execute("""
                SELECT code, user_id, expires_at, redeemed_by
                FROM buddy_invites
                WHERE code = %s
                FOR UPDATE
            """, (code,))

            invite = cur.fetchone()

            if not invite:
                raise HTTPException(status_code=404, detail="Invalid invite code.")

            if invite["redeemed_by"] is not None:
                raise HTTPException(
                    status_code=400,
                    detail="That code has already been used.",
                )

            if invite["expires_at"] <= datetime.now(ZoneInfo("UTC")):
                raise HTTPException(
                    status_code=400,
                    detail="That code has expired. Ask them for a new one.",
                )

            owner_id = int(invite["user_id"])

            if owner_id == user_id:
                raise HTTPException(
                    status_code=400,
                    detail="That's your own code — share it with a friend instead.",
                )

            low, high = buddy_pair(user_id, owner_id)

            cur.execute("""
                SELECT 1 FROM buddies WHERE user_a = %s AND user_b = %s
            """, (low, high))

            if cur.fetchone():
                raise HTTPException(
                    status_code=400,
                    detail="You're already buddies.",
                )

            for candidate in (user_id, owner_id):
                if count_buddies(cur, candidate) >= BUDDY_MAX_PER_USER:
                    raise HTTPException(
                        status_code=400,
                        detail=(
                            "You've reached the buddy limit."
                            if candidate == user_id
                            else "They've reached their buddy limit."
                        ),
                    )

            cur.execute("""
                INSERT INTO buddies (user_a, user_b)
                VALUES (%s, %s)
            """, (low, high))

            cur.execute("""
                UPDATE buddy_invites
                SET redeemed_by = %s, redeemed_at = NOW()
                WHERE code = %s
            """, (user_id, code))

            cur.execute("SELECT id, name, email FROM users WHERE id = %s", (owner_id,))
            owner = cur.fetchone()

            conn.commit()

        return {
            "message": "Buddy added.",
            "buddy": {
                "id": owner_id,
                "name": clean_text(owner["name"]) if owner else "Student",
                "email": clean_text(owner["email"]) if owner else "",
            },
        }

    except HTTPException:
        conn.rollback()
        raise
    except Exception:
        conn.rollback()
        logger.exception("Failed to redeem buddy code for user %s", user_id)
        raise HTTPException(status_code=500, detail="Failed to add buddy")
    finally:
        conn.close()


@app.delete("/users/{user_id}/buddies/{buddy_id}")
def remove_buddy(
    user_id: int,
    buddy_id: int,
    _: None = Depends(require_service_secret),
):
    low, high = buddy_pair(user_id, buddy_id)

    conn = get_conn()
    try:
        _ensure_buddy_tables(conn)

        with conn.cursor() as cur:
            cur.execute("""
                DELETE FROM buddies
                WHERE user_a = %s AND user_b = %s
            """, (low, high))

            removed = cur.rowcount
            conn.commit()

        if not removed:
            raise HTTPException(status_code=404, detail="Buddy not found.")

        return {"message": "Buddy removed."}

    except HTTPException:
        conn.rollback()
        raise
    except Exception:
        conn.rollback()
        logger.exception("Failed to remove buddy %s for user %s", buddy_id, user_id)
        raise HTTPException(status_code=500, detail="Failed to remove buddy")
    finally:
        conn.close()


@app.get("/users/{user_id}/buddies/{buddy_id}/best-day")
def buddy_best_day(
    user_id: int,
    buddy_id: int,
    _: None = Depends(require_service_secret),
):
    """The best day for both students to bunk together."""
    conn = get_conn()
    try:
        _ensure_buddy_tables(conn)

        buddy = fetch_buddy(conn, user_id, buddy_id)

        if not buddy:
            # Same response whether they're a stranger or don't exist, so this
            # can't be used to probe which user ids are real.
            raise HTTPException(status_code=404, detail="Buddy not found.")

        user_ids = [user_id, buddy_id]
        subjects_by_user = load_subjects_for_users(conn, user_ids)
        day_maps = load_timetables_for_users(conn, user_ids)

        my_subjects = subjects_by_user.get(user_id, [])
        buddy_subjects = subjects_by_user.get(buddy_id, [])

        buddy_name = clean_text(buddy["name"]) or "Your buddy"

        if not my_subjects:
            raise HTTPException(
                status_code=400,
                detail="Add your subjects before planning with a buddy.",
            )

        if not buddy_subjects:
            raise HTTPException(
                status_code=400,
                detail=f"{buddy_name} hasn't added their subjects yet.",
            )

        week = compute_buddy_week(
            my_subjects,
            day_maps.get(user_id, {}),
            buddy_subjects,
            day_maps.get(buddy_id, {}),
        )

        if not week["days"]:
            raise HTTPException(
                status_code=400,
                detail="Neither of you has a timetable saved yet.",
            )

        return {
            "buddy": {"id": buddy_id, "name": buddy_name},
            **week,
        }

    except HTTPException:
        raise
    except Exception:
        logger.exception(
            "Failed to compute buddy best day for %s and %s", user_id, buddy_id
        )
        raise HTTPException(status_code=500, detail="Failed to compute best day")
    finally:
        conn.close()
