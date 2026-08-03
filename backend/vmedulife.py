"""
vmedulife student-portal client.

Reverse-engineered from the portal's login SPA and the "Academic Planning"
page (/student/Planning/GroupSubjectList.php). Given a student's ERP username
and password, this logs in server-side and pulls subject-wise attendance,
returning it in the exact shape the /import-attendance endpoint already
consumes — so it is a drop-in replacement for the copy-paste flow.

Request flow (all POST to portal.vmedulife.com):
  1. getInstituteDataByURL      -> institute id from the college url slug
  2. verifyInstituteUserCredentials -> tokens + studentData
  3. getLearnerAcayrStreamGroupList  -> streams and their groups
  4. getLearnerAssignedSubjectList   -> subjects per (stream, group)
  5. planning_GetStudentSubjectwiseAttendance -> per-subject counts

Every request must carry an Origin/Referer from portal.vmedulife.com or the
server replies {"error":"API call from a third party is not allowed"}.
`data` fields are base64(JSON); the user_details cookie is base64(base64(JSON)).
"""

import base64
import json
import logging
from typing import Any, Optional

import requests

logger = logging.getLogger("vmedulife")

PORTAL_BASE = "https://portal.vmedulife.com"
DEFAULT_SLUG = "mlrit-hyderabad"
_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
)
_TIMEOUT = 30  # seconds per request


class ERPError(Exception):
    """A user-surfaceable ERP failure. `status` maps to an HTTP status code."""

    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.message = message
        self.status = status


def _b64(obj: Any) -> str:
    return base64.b64encode(json.dumps(obj).encode("utf-8")).decode("ascii")


def _headers(referer_path: str = "/public/auth/") -> dict:
    return {
        "Origin": PORTAL_BASE,
        "Referer": f"{PORTAL_BASE}{referer_path}",
        "User-Agent": _UA,
        "X-Requested-With": "XMLHttpRequest",
    }


def _post_json(
    session: requests.Session,
    path: str,
    *,
    data=None,
    files=None,
    headers: Optional[dict] = None,
) -> Any:
    """POST and parse the JSON body, tolerating the portal's leading whitespace."""
    url = f"{PORTAL_BASE}{path}"
    try:
        resp = session.post(
            url,
            data=data,
            files=files,
            headers=headers or _headers(),
            timeout=_TIMEOUT,
        )
    except requests.Timeout as exc:
        raise ERPError("The college portal timed out. Please try again.", 504) from exc
    except requests.RequestException as exc:
        logger.warning("ERP request to %s failed: %s", path, exc)
        raise ERPError("Could not reach the college portal. Please try again later.", 502) from exc

    text = (resp.text or "").strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        snippet = text[:200]
        logger.warning("ERP non-JSON response from %s: %s", path, snippet)
        if "third party" in snippet.lower():
            raise ERPError("Portal rejected the request.", 502) from exc
        raise ERPError("The college portal returned an unexpected response.", 502) from exc


def resolve_institute_id(session: requests.Session, slug: str) -> int:
    payload = {"getInstituteDataByURL": (None, "true"), "data": (None, _b64({"url": slug}))}
    result = _post_json(session, "/api/generic_api.php", files=payload)
    if str(result.get("success")).lower() != "true":
        raise ERPError(f"Unknown college '{slug}'.", 400)
    try:
        return int(result["data"]["InstituteId"])
    except (KeyError, TypeError, ValueError) as exc:
        raise ERPError("Could not resolve the college on the portal.", 502) from exc


def _build_session_cookies(session: requests.Session, login: dict) -> None:
    """Recreate the cookies the browser sets after a student login."""
    sd = login["studentData"]
    tokens = login["tokenDetails"]["data"]

    def cval(v):
        return "" if v is None else v

    user_details_obj = {
        "data": {
            "account": login.get("account"),
            "user_id": login.get("user"),
            "Acayear": sd.get("Acayear"),
            "admissionYear": sd.get("admissionYear"),
            "DOB": sd.get("DOB"),
            "EmailId": sd.get("EmailId"),
            "FirstName": sd.get("FirstName"),
            "InstitudeId": sd.get("InstitudeId"),
            "InstituteLogo": sd.get("InstituteLogo"),
            "InstituteSecondaryLogo": sd.get("InstituteSecondaryLogo", ""),
            "InstituteName": sd.get("InstituteName"),
            "InstituteShortName": sd.get("InstituteShortName"),
            "InstituteUrl": sd.get("InstituteUrl"),
            "LastName": sd.get("LastName"),
            "MobileNumber": sd.get("MobileNumber"),
            "PRNno": sd.get("PRNno"),
            "PlStream": sd.get("PlStream"),
            "Points": sd.get("Points"),
            "UserDp": sd.get("UserDp"),
            "stuid": sd.get("stuid"),
            "DeviceId": sd.get("deviceId"),
        },
        "role": "learner",
        "success": "true",
    }
    user_details = base64.b64encode(_b64(user_details_obj).encode()).decode()
    acyear = base64.b64encode(_b64(login.get("AcademicYearList", [])).encode()).decode()

    elective = sd.get("electiveBatches")
    elective_data = elective.get("data") if isinstance(elective, dict) else []

    cookies = {
        "user_token": tokens["user_token"],
        "sync_token": tokens["sync_token"],
        "user_details": user_details,
        "user_token_wc": tokens["user_token"],
        "sync_token_wc": tokens["sync_token"],
        "user_details_wc": user_details,
        "acyear": acyear,
        "learner_groupDetailsArray": _b64(sd.get("groupDetailsArray", [])),
        "learner_studentAssignedBatches": _b64(sd.get("studentAssignedBatches", {})),
        "learner_studentAssignedElectiveBatches": _b64(elective_data or []),
    }
    for name, value in cookies.items():
        session.cookies.set(name, cval(value), domain="portal.vmedulife.com", path="/")


def login(session: requests.Session, username: str, password: str, institute_id: int) -> dict:
    payload = {
        "verifyInstituteUserCredentials": (None, "true"),
        "data": (None, _b64({"username": username, "password": password, "institute_id": institute_id})),
    }
    result = _post_json(session, "/api/generic_api.php", files=payload)

    if str(result.get("success")).lower() != "true":
        msg = result.get("message") or "Invalid ERP username or password."
        raise ERPError(msg, 401)

    if result.get("account") != "student":
        raise ERPError("This ERP login is not a student account.", 400)

    if "tokenDetails" not in result or "studentData" not in result:
        raise ERPError("Portal login response was incomplete.", 502)

    _build_session_cookies(session, result)
    return result


def _learner_form(session: requests.Session, path: str, body: str) -> Any:
    headers = _headers("/student/Planning/GroupSubjectList.php")
    headers["Content-Type"] = "application/x-www-form-urlencoded"
    return _post_json(session, path, data=body, headers=headers)


def _fetch_stream_groups(session: requests.Session, stuid, acayr, iid) -> dict:
    body = f"getLearnerAcayrStreamGroupList=true&studentid={stuid}&acayr={acayr}&iid={iid}"
    result = _learner_form(session, "/api/learner/generic_api.php", body)
    return result.get("data", {}) if isinstance(result, dict) else {}


def _fetch_subject_list(session, stuid, acayr, sid_array, group_array) -> dict:
    body = (
        "getLearnerAssignedSubjectList=true"
        f"&learnerid={stuid}&acayr={acayr}"
        f"&sidArray={json.dumps(sid_array)}&groupIdArray={json.dumps(group_array)}"
    )
    result = _learner_form(session, "/api/learner/subject_api.php", body)
    return result.get("data", {}) if isinstance(result, dict) else {}


def _fetch_attendance(session, user_token, *, iid, sid, groupid, stuid, acayr, subject_data) -> dict:
    inp = {
        "iid": iid,
        "fromDate": "",
        "toDate": "",
        "filterType": "",
        "sid": sid,
        "acayr": acayr,
        "groupid": groupid,
        "studentId": stuid,
        "subjectData": json.dumps(subject_data),
    }
    token_input = {"source": "web", "uid": stuid, "role": "learner"}
    body = (
        "planning_GetStudentSubjectwiseAttendance=true"
        f"&data={_b64(inp)}&tokenInputParameter={_b64(token_input)}"
    )
    headers = _headers("/student/Planning/GroupSubjectList.php")
    headers["Content-Type"] = "application/x-www-form-urlencoded"
    headers["Authorization"] = f"Basic {user_token}"
    result = _post_json(session, "/api/learner/subject_api.php", data=body, headers=headers)
    return result if isinstance(result, dict) else {}


def _pick(d: dict, *keys, default=None):
    for k in keys:
        if k in d and d[k] not in (None, ""):
            return d[k]
    return default


def fetch_attendance(username: str, password: str, slug: str = DEFAULT_SLUG) -> dict:
    """
    Log in and return normalized attendance:

        {
          "subjects":   [{"subjectid": "<id>", "subject_name": "<name>"}, ...],
          "attendance": {"<id>": {"totalsessions": int,
                                   "presentSessionsCount": int,
                                   "percentage": "NN.NN"}},
          "average":    <float>,
          "student":    {"name": ..., "prn": ..., "stuid": ...},
        }

    Empty subjects/attendance is a valid result (e.g. no classes conducted yet).
    """
    username = (username or "").strip()
    password = password or ""
    slug = (slug or DEFAULT_SLUG).strip()
    if not username or not password:
        raise ERPError("ERP username and password are required.", 400)

    session = requests.Session()
    try:
        institute_id = resolve_institute_id(session, slug)
        auth = login(session, username, password, institute_id)

        sd = auth["studentData"]
        stuid = sd.get("stuid")
        acayr = sd.get("Acayear")
        user_token = auth["tokenDetails"]["data"]["user_token"]

        # Authoritative stream/group map; fall back to the login payload's
        # groupDetailsArray if the dedicated call comes back empty.
        stream_groups = _fetch_stream_groups(session, stuid, acayr, institute_id)
        if not stream_groups:
            stream_groups = {}
            for g in sd.get("groupDetailsArray", []) or []:
                sid = str(g.get("streamid"))
                stream_groups.setdefault(sid, {"groups": []})
                stream_groups[sid]["groups"].append({"groupid": g.get("gid")})

        sid_array = [str(s) for s in stream_groups.keys()]
        group_array = []
        for s in stream_groups.values():
            for grp in s.get("groups", []) or []:
                gid = str(grp.get("groupid"))
                if gid and gid not in group_array:
                    group_array.append(gid)

        subjects_by_group = _fetch_subject_list(session, stuid, acayr, sid_array, group_array)

        subjects: dict[str, dict] = {}   # subjectid -> {subject_name}
        attendance: dict[str, dict] = {}
        avg_values: list[float] = []

        for sid, groups in subjects_by_group.items():
            if not isinstance(groups, dict):
                continue
            for group_id, subject_list in groups.items():
                if not isinstance(subject_list, list) or not subject_list:
                    continue

                subject_data_param = []
                meta = {}  # subject_id -> name
                for s in subject_list:
                    if not isinstance(s, dict):
                        continue
                    sub_id = _pick(s, "subject_id", "subjectid")
                    if sub_id is None:
                        continue
                    sub_id = str(sub_id)
                    name = _pick(s, "subject_name", "subjectName", default="").strip()
                    meta[sub_id] = name
                    subject_data_param.append({
                        "subject_id": sub_id,
                        "subjectType": _pick(s, "subject_type", "subjectType", default=""),
                        "batchId": _pick(s, "batch_Id", "batchId", "batchid", default=""),
                    })

                if not subject_data_param:
                    continue

                att = _fetch_attendance(
                    session, user_token,
                    iid=institute_id, sid=sid, groupid=group_id,
                    stuid=stuid, acayr=acayr, subject_data=subject_data_param,
                )
                try:
                    avg_values.append(float(att.get("averageAttendance") or 0))
                except (TypeError, ValueError):
                    pass

                att_data = att.get("data") if isinstance(att.get("data"), dict) else {}
                for sub_id, name in meta.items():
                    row = att_data.get(sub_id) or att_data.get(str(sub_id)) or {}
                    total = int(_pick(row, "totalsessions", "total", default=0) or 0)
                    present = int(_pick(row, "presentSessionsCount", "present", default=0) or 0)
                    pct = _pick(row, "percentage", default=None)
                    if pct is None:
                        pct = round((present / total) * 100, 2) if total else 0
                    subjects[sub_id] = {"subject_name": name or f"Subject {sub_id}"}
                    attendance[sub_id] = {
                        "totalsessions": total,
                        "presentSessionsCount": present,
                        "percentage": f"{float(pct):.2f}",
                    }

        return {
            "subjects": [
                {"subjectid": sid, "subject_name": v["subject_name"]}
                for sid, v in subjects.items()
            ],
            "attendance": attendance,
            "average": round(sum(avg_values) / len(avg_values), 2) if avg_values else 0,
            "student": {
                "name": (f"{sd.get('FirstName','')} {sd.get('LastName','')}").strip(),
                "prn": sd.get("PRNno"),
                "stuid": sd.get("stuid"),
            },
        }
    finally:
        session.close()
