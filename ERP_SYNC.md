# Server-Side ERP Attendance Sync

Replaces the copy-paste import with a direct, server-side login to the college
portal (**vmedulife**). A student enters their ERP ID + password once; BunkMax
logs in on their behalf, pulls subject-wise attendance, and imports it. Login
can be saved (encrypted) for one-tap re-sync and a daily auto-sync.

The old copy-paste flow is **kept** as a fallback (collapsed under "Paste
manually instead" on the Import page).

---

## 1. Reverse-engineered portal API

The portal (`portal.vmedulife.com`) is a React SPA backed by PHP endpoints.
The attendance data comes from the "Academic Planning" page
(`/student/Planning/GroupSubjectList.php`). All of the following was decoded
from the shipped JS bundles and verified live.

**Guards / encoding**
- Every request **must** send `Origin: https://portal.vmedulife.com` and a
  matching `Referer`, or the server replies
  `{"error":"API call from a third party is not allowed"}`.
- `data` form fields are `base64(JSON)`.
- The `user_details` cookie is `base64(base64(JSON))`.
- Learner endpoints authenticate with `Authorization: Basic <user_token>`
  plus session cookies.

**Request flow** (all POST):

| # | Endpoint | Action / body | Returns |
|---|----------|---------------|---------|
| 1 | `/api/generic_api.php` | `getInstituteDataByURL` + `data=base64({url:slug})` | `InstituteId` (MLRIT slug `mlrit-hyderabad` → `1069`) |
| 2 | `/api/generic_api.php` | `verifyInstituteUserCredentials` + `data=base64({username,password,institute_id})` | `tokenDetails` (user_token, sync_token), `studentData` (stuid, Acayear, groupDetailsArray…), `AcademicYearList` |
| 3 | `/api/learner/generic_api.php` | `getLearnerAcayrStreamGroupList=true&studentid=&acayr=&iid=` | streams → `[{groupid}]` |
| 4 | `/api/learner/subject_api.php` | `getLearnerAssignedSubjectList=true&learnerid=&acayr=&sidArray=&groupIdArray=` | `data[sid][groupId] = [{subject_id, subject_name, subject_type, batch_Id}]` |
| 5 | `/api/learner/subject_api.php` | `planning_GetStudentSubjectwiseAttendance=true&data=base64(inputParam)&tokenInputParameter=base64({source:web,uid,role:learner})` (header `Authorization: Basic <user_token>`) | `{averageAttendance, data:{<subject_id>:{percentage, presentSessionsCount, totalsessions}}}` |

Between steps 2 and 3 the client sets session cookies from the login response
(`user_token`, `sync_token`, `user_details`, their `_wc` variants, `acyear`,
`learner_groupDetailsArray`, …); the server-side client recreates these.

The subject id ↔ attendance map is normalized into the payload the existing
importer already understands:

```json
{
  "subjects":   [{ "subjectid": "<id>", "subject_name": "<name>" }],
  "attendance": { "<id>": { "totalsessions": 0, "presentSessionsCount": 0, "percentage": "0.00" } }
}
```

> Empty attendance is a **valid** result — e.g. when no classes have been
> conducted yet. It is not treated as an error.

---

## 2. Architecture

```
Import page  ──►  Next.js proxy  ──►  FastAPI backend  ──►  vmedulife portal
(erpSync)        (/api/backend/*)     (/users/{id}/erp-*)     (login → attendance)
                 adds service secret   vmedulife.py client
                                       crypto_util.py (Fernet)
                                       erp_credentials table (Postgres)
```

The existing frontend proxy already forwards every `/users/{id}/*` call with
the backend service secret, so the new endpoints needed **no proxy changes**.

---

## 3. Files

### New — backend
- **`backend/vmedulife.py`** — the ERP client. `fetch_attendance(username,
  password, slug)` runs the full login → attendance pipeline and returns the
  normalized payload plus `average` and `student` info. Raises `ERPError`
  (with an HTTP `status`) on bad credentials, portal timeouts, etc.
- **`backend/crypto_util.py`** — Fernet (AES-128-CBC + HMAC-SHA256)
  `encrypt` / `decrypt` for stored ERP passwords. Key comes from the
  `ERP_CRED_KEY` env var only; never stored in the DB or repo.

### Modified — backend (`backend/main.py`)
- `ERPSyncPayload` model.
- `_upsert_erp_subjects(cur, user_id, subjects, attendance)` — shared upsert
  helper extracted from the copy-paste importer (now used by both paths).
- `_run_erp_sync(...)` — fetch → upsert → optionally persist credentials.
- New endpoints (all behind the service secret):
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

### Modified — backend (other)
- `requirements.txt` — pinned `requests`, `cryptography` (both already present
  transitively).
- `.env.example` — documented `ERP_CRED_KEY` + how to generate it.
- `render.yaml` — noted `ERP_CRED_KEY` in the dashboard-secrets list.

### Modified — frontend
- **`lib/api.ts`** — `erpSync`, `erpResync`, `getErpStatus`,
  `deleteErpCredentials` + their types.
- **`app/import/page.tsx`** — a **Sync from Portal** card on top:
  - Not saved yet → ERP ID + password (show/hide) + "keep me synced" checkbox
    (default on) + **Sync from Portal**.
  - Saved → "Signed in as … · last synced …" with **Sync now**, "Use a
    different login", and "Remove saved login".
  - Copy-paste importer preserved under a **Paste manually instead** toggle.

### Database

```sql
CREATE TABLE IF NOT EXISTS erp_credentials (
    user_id          INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    erp_username     TEXT NOT NULL,
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
- Sync is **non-destructive**: it upserts only the subjects it fetches
  (`ON CONFLICT (user_id, subject_name)`); it never deletes existing subjects.

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

- `erp-sync` (save on) → logged in, saved encrypted creds, returned 0 subjects
  (no classes) — correct.
- `erp-status` → `saved: true`, username, last-synced, `ok`.
- `erp-resync` → decrypted stored password and re-fetched.
- Wrong password → `401 Invalid username or password`.
- Missing service secret → `401`.
- Delete credentials → removed.
- Existing subjects left untouched; test credential cleaned up afterwards.
- Frontend `tsc --noEmit` ✓, `eslint` ✓.
