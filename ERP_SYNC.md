# Server-Side ERP Attendance Sync

Replaces the copy-paste import with a direct, server-side login to the college
portal (**CampusHub**). A student enters their ERP roll number + password once;
BunkMax logs in on their behalf, pulls subject-wise attendance and the weekly
timetable, and imports both. Login can be saved (encrypted) for one-tap
re-sync and a daily auto-sync.

The old copy-paste flow is **kept** as a fallback (collapsed under "Paste
manually instead" on the Import page).

---

## 1. Reverse-engineered portal API

CampusHub (`campushub.mlrit.ac.in`) is a Next.js SPA backed **directly by
Supabase** — there is no bespoke attendance API. The contract below was decoded
from the shipped JS bundles and verified live.

**Auth — AWS Cognito**

CampusHub has **migrated off Supabase auth onto AWS Cognito**. The portal posts
to its own sign-in route and then sends the **`idToken`** (not `accessToken`)
as `Authorization: Bearer` on every `/api/student/*` call — see `authHeader()`
/ `getAccessToken()` in the shipped bundle. Email is still
`<roll-lowercase>@mlrit.ac.in`, so we construct it directly.

| # | Endpoint | Body / params | Returns |
|---|----------|---------------|---------|
| 1 | `POST campushub.mlrit.ac.in/api/auth/cognito-signin` | `{email, password}` | `{idToken, accessToken, refreshToken, expiresIn}` |

- `400`/`401`/`403` means bad credentials — maps to "Invalid ERP roll number or
  password".
- A `200` carrying `{challenge: "NEW_PASSWORD_REQUIRED", session}` means the
  account has never set a password. No API route will serve it, so we ask the
  student to sign in to the portal once first.
- The old Supabase password grant still *answers*, but students are no longer
  provisioned there — do not use it.

**Attendance**

Use **CampusHub's own attendance module**. It is server-aggregated and already
scoped to the **current semester**, so BunkMax does no date filtering.

| # | Endpoint | Params | Returns |
|---|----------|--------|---------|
| 2 | `GET campushub.mlrit.ac.in/api/student/attendance` (header `Authorization: Bearer <idToken>`) | **none** — the route derives the student from the token | see below |

```json
{
  "student": { "roll_number": "…", "name": "…", "department": "CSE",
               "section": "A", "year": "I", "semester": "I" },
  "attendance_from": "2026-08-11",
  "overall_stats": { "total_classes": 156, "classes_attended": 68,
                     "attendance_percentage": 43.6,
                     "days_needed_for_75_percent": 196 },
  "overall": { "present": 68, "absent": 40, "late": 0,
               "total": 156, "percentage": 43.6 },
  "subject_wise_attendance": [{ "subject_name": "…", "subject_code": "A7CS01",
                                "total_classes": 55, "classes_attended": 21,
                                "attendance_percentage": 38.2 }],
  "subjects": [{ "subject_code": "A7CS01", "subject_name": "…", "faculty": "…",
                 "present": 21, "absent": 24, "late": 0,
                 "total": 55, "percentage": 38.2 }],
  "daily":   [{ "date": "2026-08-13", "present": 3, "absent": 3, "late": 0,
                "status": "partial" }],
  "records": [{ "date": "2026-09-03", "subject_code": "A7BS01",
                "subject_name": "…", "status": "present", "remarks": null }],
  "recent_attendance": [ "…same shape as records…" ]
}
```

- `attendance_from` is the **semester start** the portal is counting from, so
  the window is the portal's business, not ours.
- `overall_stats` / `subject_wise_attendance` are the BunkMax-shaped aliases;
  `overall` / `subjects` carry the same numbers plus `faculty` and a
  present/absent/late split. `daily` is a per-day rollup
  (`status`: `present` / `absent` / `partial`).
- **`total` counts scheduled classes, not just marked ones.** Verified live:
  `present 68 + absent 40 = 108`, but `total = 156` — 48 classes are on the
  timetable with no mark either way, and the portal counts them against the
  student (`68/156 = 43.6%`, not `68/108 = 63%`). We take the portal's figures
  verbatim so BunkMax shows the same number the college does.
- `records` rows carry `remarks`; `period_number` / `faculty_name` appear in
  the portal's own grouping code but are **not** in the payload — treat them as
  optional.

- `subject_wise_attendance` is exactly the shape `_normalize_attendance` wants.
- `overall_stats.attendance_percentage` is **total-based**, so we prefer it over
  our own mean-of-subject-percentages average.
- Per-record `status` is `present` / `late` / `absent`, and the portal counts
  **`late` as attended** (`ATTENDED_STATUSES`) — so we must too.
- `records` supersedes `recent_attendance` when non-empty; the portal reads
  `records` first and falls back the same way.

**Fallback chain** (used only when the module returns no subjects):

| # | Source | Notes |
|---|--------|-------|
| 2a | `GET {SUPABASE_URL}/rest/v1/attendance_records` + `attendance_sessions!inner(...)`, `attendance_sessions.status=eq.closed` | Current session tables, keyed by `student_roll_number`. Only `closed` sessions count — an `open` one is mid-marking and would understate the total. |
| 2b | `GET {SUPABASE_URL}/rest/v1/student_attendance_summary` | Frozen pre-migration view (`student_id`, mixed roll/uuid keys). Kept so older history survives. |

> Both fallbacks read Supabase directly and are queried with **`ANON_KEY`** —
> a Cognito `idToken` does not authenticate Supabase. They are world-readable,
> so the client **must** filter by roll number itself.

**Timetable**

The raw `timetable` table stores subject uuids and `subjects` is RLS-locked to
students, so we use CampusHub's own server route, which resolves names for us.

| # | Endpoint | Params | Returns |
|---|----------|--------|---------|
| 3 | `POST campushub.mlrit.ac.in/api/auth/login` | `{rollNumber}` | `user` profile — `department`, `section`, `year`, `semester`, `name` |
| 4 | `GET campushub.mlrit.ac.in/api/student/timetable` (header `Authorization: Bearer <idToken>`) | `department`, `section`, `year`, `semester` | `{classes: [{weekday, period_start, period_end, subject_name, subject_code, is_recurring, start_date, end_date}]}` |

Timetable normalization rules (`_normalize_timetable`):

- `weekday` follows JS `Date.getDay()` — `0` = Sunday … `6` = Saturday.
- A row covers `period_start..period_end`; labs span several periods and are
  expanded into one entry per period, clipped to BunkMax's 6-period grid.
- Only **currently-active recurring** rows count: `is_recurring` must be true,
  and any `start_date`/`end_date` window must contain today. One-off classes
  must never overwrite the weekly grid.
- Batch-split labs leave `batch` null, so two rows can claim one slot. The
  first by subject name wins, deterministically, and the loser is reported in
  `timetable_conflicts` rather than silently dropped.

**Normalized payload**

Both datasets are normalized into the shape the existing importer already
understands:

```json
{
  "subjects":   [{ "subjectid": "<name>", "subject_name": "<name>" }],
  "attendance": { "<name>": { "totalsessions": 0, "presentSessionsCount": 0, "percentage": "0.00" } },
  "average":    0,
  "student":    { "name": "…", "prn": "<roll>", "stuid": "<roll>" },
  "timetable":  [{ "day_name": "Monday", "period_no": 1, "subject_name": "…" }],
  "timetable_conflicts": []
}
```

> Empty attendance is a **valid** result — e.g. when no classes have been
> conducted yet. It is not treated as an error. A timetable failure is
> likewise non-fatal: attendance still syncs and `timetable` comes back empty.

---

## 2. Architecture

```
Import page  ──►  Next.js proxy  ──►  FastAPI backend  ──►  CampusHub / Supabase
(erpSync)        (/api/backend/*)     (/users/{id}/erp-*)    (login → attendance
                 adds service secret   campushub.py client                → timetable)
                                       crypto_util.py (Fernet)
                                       erp_credentials table (Postgres)
```

The existing frontend proxy already forwards every `/users/{id}/*` call with
the backend service secret, so the ERP endpoints needed **no proxy changes**.

---

## 3. Files

### Backend
- **`backend/campushub.py`** — the ERP client. `fetch_all(username, password,
  slug, *, with_timetable=True)` does one login and returns attendance +
  timetable; `fetch_attendance(...)` is the attendance-only wrapper. Raises
  `ERPError` (with an HTTP `status`) on bad credentials, portal timeouts, etc.
  `slug` is vestigial (single institute) and ignored, kept for the stored-
  credential column and signature compatibility. Running the module directly
  with no arguments executes offline self-checks of both normalizers; with
  `<roll> <password>` it prints a live payload.
- **`backend/crypto_util.py`** — Fernet (AES-128-CBC + HMAC-SHA256)
  `encrypt` / `decrypt` for stored ERP passwords. Key comes from the
  `ERP_CRED_KEY` env var only; never stored in the DB or repo.

### Backend (`backend/main.py`)
- `ERPSyncPayload` model.
- `_upsert_erp_subjects(cur, user_id, subjects, attendance)` — shared upsert
  helper used by both the ERP and copy-paste paths. Non-destructive.
- `_upsert_timetable(cur, user_id, entries)` — replaces the weekly grid.
  Destructive on purpose (the portal is authoritative, so moved or dropped
  slots must disappear), but a no-op on empty input so a portal hiccup can
  never wipe a saved timetable.
- `_run_erp_sync(...)` — fetch → upsert → optionally persist credentials.
- Endpoints (all behind the service secret):
  - `POST /users/{id}/erp-sync` — login, import, optionally save creds.
  - `POST /users/{id}/erp-resync` — re-sync from **saved** creds (no password
    in the request).
  - `GET  /users/{id}/erp-status` — `{saved, erp_username, last_synced_at, …}`.
    Never returns the password.
  - `DELETE /users/{id}/erp-credentials` — forget the saved login.
  - `GET|POST /cron/erp/sync-all` — daily best-effort re-sync of every user
    with saved creds (behind the notification-cron secret). Returns
    `{started, total}` at once and syncs in the background,
    `ERP_CRON_WORKERS` (default 3) users at a time; per-user results land in
    `erp_credentials.last_sync_status`.
- `erp_credentials` table added to `init_db` **and** `migrate_db`; also created
  lazily (`CREATE TABLE IF NOT EXISTS`) inside the ERP endpoints so it
  self-heals without a manual migration.

### Backend (other)
- `requirements.txt` — pinned `requests`, `cryptography`.
- `.env.example` — documented `ERP_CRED_KEY` + how to generate it.
- `render.yaml` — noted `ERP_CRED_KEY` in the dashboard-secrets list.

### Frontend
- **`lib/api.ts`** — `erpSync`, `erpResync`, `getErpStatus`,
  `deleteErpCredentials` + their types.
- **`app/import/page.tsx`** — a **Sync from Portal** card on top:
  - Not saved yet → ERP roll number + password (show/hide) + "keep me synced"
    checkbox (default on) + **Sync from Portal**.
  - Saved → "Signed in as … · last synced …" with **Sync now**, "Use a
    different login", and "Remove saved login".
  - Copy-paste importer preserved under a **Paste manually instead** toggle.

### Database

```sql
CREATE TABLE IF NOT EXISTS erp_credentials (
    user_id          INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    erp_username     TEXT NOT NULL,          -- the roll number
    erp_password_enc TEXT NOT NULL,          -- Fernet ciphertext
    institute_slug   TEXT DEFAULT 'mlrit-hyderabad',
    last_synced_at   TIMESTAMPTZ,
    last_sync_status TEXT DEFAULT '',
    created_at       TIMESTAMPTZ DEFAULT NOW(),
    updated_at       TIMESTAMPTZ DEFAULT NOW()
);
```

---

## 4. Security

- ERP passwords are **encrypted at rest** with Fernet; the key
  (`ERP_CRED_KEY`) lives only in the environment.
- The password is never sent back to the client (`erp-status` returns username
  + last-synced only).
- If the key rotates, old ciphertext can't be decrypted — the user re-enters
  once (handled with a clean `409`).
- If `ERP_CRED_KEY` is **absent**, the sync still runs — the password is used
  for that request only and never persisted. `erp-sync` returns success with a
  `credentials_error` note (shown as a footnote on the success message), and
  `erp-status` reports `crypto_available: false` so `/import` can warn up front.
  A missing key must never fail an otherwise-valid sync.
- The Supabase publishable (anon) key is not a secret — it ships in CampusHub's
  own JS bundle — but it grants read access to the attendance tables, which is
  why the client always filters by the caller's own roll number.
- Attendance sync is **non-destructive**: it upserts only the subjects it
  fetches (`ON CONFLICT (user_id, subject_name)`) and never deletes existing
  ones. The timetable sync is the one deliberate exception (see above).

---

## 5. Deployment

1. **Set `ERP_CRED_KEY`** in the Render dashboard (required to save logins):
   ```bash
   python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
   ```
2. **Table**: self-heals on first ERP call; also covered by `/init-db` and
   `/migrate-db`. No manual step required.
3. **Daily auto-sync**: point an external scheduler (Render cron /
   cron-job.org) at `POST /cron/erp/sync-all` with the
   `NOTIFICATION_CRON_SECRET`, alongside the existing notification crons.

> **Proxy timeout:** the Next.js proxy caps backend calls at 30s
> (`BACKEND_TIMEOUT_MS`). A sync makes several portal round-trips; if real
> syncs approach that, raise `BACKEND_TIMEOUT_MS` (route `maxDuration` is
> already 60s).

---

## 6. Verification

Tested live against the portal + production DB:

- `erp-sync` (save on) → logged in, saved encrypted creds, imported subjects
  and the weekly timetable.
- `erp-status` → `saved: true`, username, last-synced, `ok`.
- `erp-resync` → decrypted stored password and re-fetched.
- Wrong password → `401 Invalid ERP roll number or password`.
- Missing service secret → `401`.
- Delete credentials → removed.
- Existing subjects left untouched; test credential cleaned up afterwards.
- `python backend/campushub.py` → normalizer self-checks pass.
- Frontend `tsc --noEmit` ✓, `eslint` ✓.
