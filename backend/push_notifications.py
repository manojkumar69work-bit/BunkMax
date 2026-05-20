from __future__ import annotations

import json
import logging
import os
from typing import Any

from database import get_conn
from firebase_admin import credentials, get_app, initialize_app, messaging


logger = logging.getLogger("bunkmax.push")

DEFAULT_FRONTEND_URL = "https://bunk-max.vercel.app"
DEFAULT_ICON_PATH = "/android-chrome-192x192.png"
MAX_MULTICAST_TOKENS = 500


def _chunked(values: list[str], size: int) -> list[list[str]]:
    return [values[index:index + size] for index in range(0, len(values), size)]


def _initialize_firebase_admin() -> None:
    try:
        get_app()
        return
    except ValueError:
        pass

    service_account_json = os.getenv("FIREBASE_SERVICE_ACCOUNT_JSON", "").strip()
    service_account_file = os.getenv("FIREBASE_SERVICE_ACCOUNT_FILE", "").strip()
    google_credentials = os.getenv("GOOGLE_APPLICATION_CREDENTIALS", "").strip()

    if service_account_json:
        try:
            parsed_service_account = json.loads(service_account_json)
        except json.JSONDecodeError as exc:
            raise RuntimeError("FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON") from exc

        credential = credentials.Certificate(parsed_service_account)
    elif service_account_file:
        credential = credentials.Certificate(service_account_file)
    elif google_credentials:
        credential = credentials.ApplicationDefault()
    else:
        raise RuntimeError(
            "Firebase Admin is not configured. Set FIREBASE_SERVICE_ACCOUNT_JSON "
            "or FIREBASE_SERVICE_ACCOUNT_FILE."
        )

    initialize_app(credential)


def _get_user_tokens(user_id: int) -> list[str]:
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT token
                FROM push_tokens
                WHERE user_id = %s
                ORDER BY updated_at DESC
            """, (user_id,))

            return [str(row["token"]) for row in cur.fetchall() if row.get("token")]
    finally:
        conn.close()


def _delete_tokens(tokens: list[str]) -> None:
    if not tokens:
        return

    conn = get_conn()
    try:
        with conn.cursor() as cur:
            for token in tokens:
                cur.execute("DELETE FROM push_tokens WHERE token = %s", (token,))

            conn.commit()
    except Exception:
        conn.rollback()
        logger.exception("Failed to delete invalid push tokens")
    finally:
        conn.close()


def _build_link(url: str) -> str | None:
    frontend_url = os.getenv("FRONTEND_URL", DEFAULT_FRONTEND_URL).strip().rstrip("/")
    safe_path = url if url.startswith("/") else "/"

    if not frontend_url.startswith("https://"):
        return None

    return f"{frontend_url}{safe_path}"


def _is_invalid_token_error(exception: BaseException | None) -> bool:
    if exception is None:
        return False

    code = str(getattr(exception, "code", "") or "").lower()
    message = str(exception).lower()

    return (
        "unregistered" in code
        or "registration-token-not-registered" in message
        or "invalid registration token" in message
    )


def send_push_notification(
    user_id: int,
    title: str,
    body: str,
    *,
    url: str = "/",
    tag: str = "bunkmax-alert",
    ttl_seconds: int = 3600,
) -> dict[str, Any]:
    """
    Send a native web push notification to every saved browser token for a user.

    Configure Firebase Admin with one of:
    - FIREBASE_SERVICE_ACCOUNT_JSON: the full service-account JSON string
    - FIREBASE_SERVICE_ACCOUNT_FILE: an absolute path to the service-account JSON
    - GOOGLE_APPLICATION_CREDENTIALS: supported by Google auth environments
    """
    clean_title = title.strip()
    clean_body = body.strip()

    if user_id <= 0:
        raise ValueError("user_id must be positive")

    if not clean_title:
        raise ValueError("title is required")

    if not clean_body:
        raise ValueError("body is required")

    tokens = _get_user_tokens(user_id)

    if not tokens:
        return {
            "success_count": 0,
            "failure_count": 0,
            "token_count": 0,
        }

    _initialize_firebase_admin()

    link = _build_link(url)
    success_count = 0
    failure_count = 0
    invalid_tokens: list[str] = []

    for token_chunk in _chunked(tokens, MAX_MULTICAST_TOKENS):
        webpush = messaging.WebpushConfig(
            headers={
                "TTL": str(ttl_seconds),
                "Urgency": "high",
            },
            fcm_options=messaging.WebpushFCMOptions(link=link) if link else None,
        )

        message = messaging.MulticastMessage(
            tokens=token_chunk,
            data={
                "title": clean_title,
                "body": clean_body,
                "url": url if url.startswith("/") else "/",
                "tag": tag,
                "icon": DEFAULT_ICON_PATH,
            },
            webpush=webpush,
        )

        response = messaging.send_each_for_multicast(message)
        success_count += response.success_count
        failure_count += response.failure_count

        for token, send_response in zip(token_chunk, response.responses):
            if not send_response.success and _is_invalid_token_error(
                send_response.exception
            ):
                invalid_tokens.append(token)

    _delete_tokens(invalid_tokens)

    return {
        "success_count": success_count,
        "failure_count": failure_count,
        "token_count": len(tokens),
    }
