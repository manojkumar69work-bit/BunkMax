# BunkMax

Attendance tracker for MLRIT students. Pulls subject-wise attendance and the
weekly timetable from the college portal (CampusHub), then tells you how many
classes you can safely skip.

- **frontend/** — Next.js 16 app (App Router, Tailwind, next-auth Google login
  restricted to `@mlrit.ac.in`). Talks to the backend only through
  `/api/backend/*`, which injects the service secret.
- **backend/** — FastAPI + Postgres (Supabase). Attendance math, timetable,
  planner, Razorpay subscriptions, Firebase push notifications, ERP sync.

## Run locally

```bash
# backend
cd backend
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload            # http://127.0.0.1:8000

# frontend
cd frontend
npm install
npm run dev                          # http://localhost:3000
```

First run: hit `GET /init-db` once (requires `ENABLE_ADMIN_DB_ROUTES=true`).
Schema changes since then are applied by `GET /migrate-db`.

## Environment

Copy `backend/.env.example` → `backend/.env` and `frontend/.env.example` →
`frontend/.env.local`, then fill in:

`backend/.env`

| Var | Notes |
|---|---|
| `DATABASE_URL` | Postgres / Supabase pooler URL |
| `BACKEND_API_SECRET` | shared with the frontend proxy; guards `/users/*` |
| `ADMIN_API_SECRET` | admin-only endpoints |
| `NOTIFICATION_CRON_SECRET` | cron endpoints |
| `ERP_CRED_KEY` | Fernet key encrypting saved portal passwords — `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"` |
| `RAZORPAY_KEY_ID` / `_SECRET` / `_WEBHOOK_SECRET` | payments |
| `SUBSCRIPTION_PRO_3MO_URL` / `_6MO_URL` | Razorpay payment-link fallbacks |
| `FIREBASE_SERVICE_ACCOUNT_JSON` or `_FILE` | push notifications |
| `FRONTEND_URL`, `ALLOWED_ORIGINS`, `APP_ENV`, `ALLOW_DEV_ORIGINS` | CORS |
| `DB_POOL_MIN/MAX`, `RATE_LIMIT_*`, `ENABLE_ADMIN_DB_ROUTES` | optional tuning |

`frontend/.env.local`

| Var | Notes |
|---|---|
| `AUTH_SECRET`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `AUTH_URL` | next-auth |
| `BACKEND_API_BASE` | defaults to `http://127.0.0.1:8000` |
| `BACKEND_API_SECRET` | must match the backend |
| `BACKEND_TIMEOUT_MS` | proxy timeout, default 30s |
| `NEXT_PUBLIC_FIREBASE_*`, `NEXT_PUBLIC_FIREBASE_VAPID_KEY` | web push |
| `NEXT_PUBLIC_RAZORPAY_KEY_ID` | checkout |

## Cron jobs

Point an external scheduler at these with the `NOTIFICATION_CRON_SECRET`:

- `POST /cron/notifications/morning` — today's class count
- `POST /cron/notifications/evening` — tomorrow's class count
- `POST /cron/erp/sync-all` — daily re-sync for users with saved logins
- `GET /health` every ~10 min to keep the free Render instance awake

## Deploy

Backend: `render.yaml` (Render blueprint; secrets set in the dashboard).
Frontend: Vercel.

## More

`ERP_SYNC.md` documents the portal sync design. The endpoints and DB schema
there are current; the portal client itself has since moved from vmedulife to
CampusHub — see `backend/campushub.py`.
