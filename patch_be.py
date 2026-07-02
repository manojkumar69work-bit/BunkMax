# Patch backend/main.py and frontend/lib/api.ts for government holidays

mp = "backend/main.py"
s = open(mp, encoding="utf-8").read()

HOL = '''
# ---- GOVERNMENT HOLIDAYS (India) ----
GOVERNMENT_HOLIDAYS: dict[str, str] = {
    "2026-01-01": "New Year's Day",
    "2026-01-14": "Makar Sankranti / Pongal",
    "2026-01-26": "Republic Day",
    "2026-02-15": "Maha Shivaratri",
    "2026-03-04": "Holi",
    "2026-03-21": "Eid-ul-Fitr",
    "2026-03-26": "Ram Navami",
    "2026-04-03": "Good Friday",
    "2026-04-14": "Ambedkar Jayanti",
    "2026-05-01": "May Day",
    "2026-05-27": "Bakrid (Eid al-Adha)",
    "2026-06-26": "Muharram",
    "2026-08-15": "Independence Day",
    "2026-09-04": "Janmashtami",
    "2026-10-02": "Gandhi Jayanti",
    "2026-10-20": "Dussehra",
    "2026-11-08": "Diwali",
    "2026-11-24": "Guru Nanak Jayanti",
    "2026-12-25": "Christmas",
    "2027-01-01": "New Year's Day",
    "2027-01-26": "Republic Day",
    "2027-08-15": "Independence Day",
    "2027-10-02": "Gandhi Jayanti",
    "2027-12-25": "Christmas",
}
'''

anchor1 = 'app = FastAPI(title="BunkMax API")'
assert anchor1 in s, "anchor1 missing"
s = s.replace(anchor1, anchor1 + "\n" + HOL, 1)

ENDPOINT = '''@app.get("/users/{user_id}/holidays")
def get_holidays(user_id: int, _: None = Depends(require_service_secret)):
    items = [
        {"date": d, "name": n}
        for d, n in sorted(GOVERNMENT_HOLIDAYS.items())
    ]
    return {"holidays": items}


'''
anchor2 = '@app.post("/users/{user_id}/calendar-plan")\ndef calendar_plan('
assert anchor2 in s, "anchor2 missing"
s = s.replace(anchor2, ENDPOINT + anchor2, 1)

anchor3 = '        weekday_name = date_obj.strftime("%A")\n\n        if weekday_name == "Sunday":'
HOLSKIP = '''        weekday_name = date_obj.strftime("%A")

        holiday_name = GOVERNMENT_HOLIDAYS.get(day_plan.date)
        if holiday_name:
            skipped_dates.append({
                "date": day_plan.date,
                "reason": "Government holiday: " + holiday_name,
            })
            continue

        if weekday_name == "Sunday":'''
assert anchor3 in s, "anchor3 missing"
s = s.replace(anchor3, HOLSKIP, 1)

open(mp, "w", encoding="utf-8").write(s)
print("backend patched")

# ---- frontend/lib/api.ts ----
ap = "frontend/lib/api.ts"
a = open(ap, encoding="utf-8").read()
HFN = '''
/* ---------------- HOLIDAYS ---------------- */

export type HolidayItem = { date: string; name: string };

export async function getHolidays(userId: number) {
  const res = await fetchWithRetry(`${API_BASE}/users/${userId}/holidays`);
  return handleResponse<{ holidays: HolidayItem[] }>(res);
}

'''
marker = "/* ---------------- FEED ---------------- */"
assert marker in a, "feed marker missing"
a = a.replace(marker, HFN + marker, 1)
open(ap, "w", encoding="utf-8").write(a)
print("api patched")
