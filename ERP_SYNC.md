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

**Auth**

Supabase email/password. The portal's own login takes a roll number and maps it
to an email server-side; we skip that hop and construct the email directly.

| # | Endpoint | Body / params | Returns |
|---|----------|---------------|---------|
| 1 | `POST {SUPABASE_URL}/auth/v1/token?grant_type=password` (header `apikey`) | `{email: "<roll-lowercase>@mlrit.ac.in", password}` | `access_token` |

`400`/`401` here means bad credentials and nothing else, so it maps cleanly to
a user-facing "Invalid ERP roll number or password".

**Attendance**

| # | Endpoint | Params | Returns |
|---|----------|--------|---------|
| 2 | `GET {SUPABASE_URL}/rest/v1/student_attendance_summary` (headers `apikey` + `Authorization: Bearer <access_token>`) | `student_id=eq.<ROLL-UPPER>`, `select=subject_name,subject_code,total_classes,classes_attended,attendance_percentage` | `[{subject_name, subject_code, total_classes, classes_attended, attendance_percentage}]` |

> The view is world-readable to any authenticated (or anon) user, so the client
> **must** filter by `student_id` itself. Live rows are keyed by **roll
> number**; a few stray demo rows use auth-uid uuids. The raw per-session table
> `attendance` (student_id, subject, class_name, date, present) also exists —
> the summary view is the aggregate we consume.

**Timetable**

The raw `timetable` table stores subject uuids and `subjects` is RLS-locked to
students, so we use CampusHub's own server route, which resolves names for us.

| # | Endpoint | Params | Returns |
|---|----------|--------|---------|
| 3 | `POST campushub.mlrit.ac.in/api/auth/login` | `{rollNumber}` | `user` profile — `department`, `section`, `year`, `semester`, `name` |
| 4 | `GET campushub.mlrit.ac.in/api/student/timetable` (header `Authorization: Bearer <access_token>`) | `department`, `section`, `year`, `semester` | `{classes: [{weekday, period_start, period_end, subject_name, subject_code, is_recurring, start_date, end_date}]}` |

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
    with saved creds (behind the notification-cron secret).
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
- The Supabase publishable (anon) key is not a secret — it ships in CampusHub's
  own JS bundle — but it grants read access to the world-readable summary view,
  which is why the client always filters by the caller's own `student_id`.
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
