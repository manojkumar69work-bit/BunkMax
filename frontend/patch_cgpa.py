f = "app/plan/page.tsx"
s = open(f, encoding="utf-8").read()

# 1) Drop ChevronDown from the lucide import (no braces in search string)
s = s.replace(", ChevronDown", "", 1)

# 2) Remove unused SEMESTERS const
SEM = (
    'const SEMESTERS = [\n'
    '  "Semester 1",\n'
    '  "Semester 2",\n'
    '  "Semester 3",\n'
    '  "Semester 4",\n'
    '  "Semester 5",\n'
    '  "Semester 6",\n'
    '  "Semester 7",\n'
    '  "Semester 8",\n'
    '];\n\n'
)
assert SEM in s, "SEMESTERS block not found"
s = s.replace(SEM, "", 1)

# 3) Remove unused grades const
GR = (
    'const grades = [\n'
    '  ["DBMS", "A required"],\n'
    '  ["OS", "A required"],\n'
    '  ["DAA", "B+ required"],\n'
    '  ["Math-IV", "A- required"],\n'
    '];\n\n'
)
assert GR in s, "grades block not found"
s = s.replace(GR, "", 1)

# 4) Swap semester state for planner state
OLD_STATE = (
    '  const [semesterOpen, setSemesterOpen] = useState(false);\n'
    '  const [semester, setSemester] = useState("Semester 4");'
)
NEW_STATE = (
    '  const [currentCgpa, setCurrentCgpa] = useState("8.0");\n'
    '  const [completedCredits, setCompletedCredits] = useState("80");\n'
    '  const [upcomingCredits, setUpcomingCredits] = useState("24");'
)
assert OLD_STATE in s, "semester state not found"
s = s.replace(OLD_STATE, NEW_STATE, 1)

# 5) Insert gradeBand + cgpaPlan after changeColor
CC = (
    '  const changeColor = (n: number) =>\n'
    '    n > 0 ? "text-green-400" : n < 0 ? "text-red-400" : "text-gray-300";'
)
assert CC in s, "changeColor not found"
INS = CC + '''

  const gradeBand = (g: number) => {
    if (g >= 9.5) return "O";
    if (g >= 9) return "A+";
    if (g >= 8) return "A";
    if (g >= 7) return "B+";
    if (g >= 6) return "B";
    if (g >= 5) return "C";
    return "below C";
  };

  const cgpaPlan = useMemo(() => {
    const cur = parseFloat(currentCgpa);
    const done = parseFloat(completedCredits);
    const next = parseFloat(upcomingCredits);
    if (
      !Number.isFinite(cur) ||
      !Number.isFinite(done) ||
      !Number.isFinite(next) ||
      next <= 0 ||
      done < 0 ||
      cur < 0 ||
      cur > 10
    ) {
      return { valid: false as const };
    }
    const required = (target * (done + next) - cur * done) / next;
    return { valid: true as const, required };
  }, [currentCgpa, completedCredits, upcomingCredits, target]);'''
s = s.replace(CC, INS, 1)

# 6) Replace the entire GPA tab block (line-anchored, no braces in search)
marker = 'tab === "GPA" ? ('
idx = s.index(marker)
start = s.rindex("\n", 0, idx) + 1
bn = s.index("<BottomNav />")
end_start = s.rindex("\n", 0, bn) + 1
NEW_GPA = '''      {tab === "GPA" ? (
        <div className="glass-card space-y-4 p-4">
          <p className="font-semibold">Target CGPA Planner</p>

          <div className="space-y-3">
            <div>
              <label className="mb-1 block text-xs text-gray-400">
                Current CGPA
              </label>
              <input
                type="number"
                inputMode="decimal"
                step="0.01"
                value={currentCgpa}
                onChange={(e) => setCurrentCgpa(e.target.value)}
                placeholder="e.g. 8.0"
                className="input-ui w-full"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs text-gray-400">
                  Completed credits
                </label>
                <input
                  type="number"
                  inputMode="numeric"
                  value={completedCredits}
                  onChange={(e) => setCompletedCredits(e.target.value)}
                  placeholder="e.g. 80"
                  className="input-ui w-full"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-gray-400">
                  Upcoming credits
                </label>
                <input
                  type="number"
                  inputMode="numeric"
                  value={upcomingCredits}
                  onChange={(e) => setUpcomingCredits(e.target.value)}
                  placeholder="e.g. 24"
                  className="input-ui w-full"
                />
              </div>
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-300">Target CGPA</span>
              <span className="text-lg font-bold text-[#ffd400]">
                {target.toFixed(1)}
              </span>
            </div>
            <input
              type="range"
              min={5}
              max={10}
              step={0.1}
              value={target}
              onChange={(e) => setTarget(Number(e.target.value))}
              className="mt-2 w-full accent-[#ffd400]"
            />
          </div>

          <div className="rounded-xl border border-white/10 bg-white/5 p-3">
            <p className="mb-1 text-sm font-semibold">Grades needed</p>
            {!cgpaPlan.valid ? (
              <p className="text-sm text-gray-400">
                Enter your current CGPA, completed credits, and upcoming credits
                to see what you need.
              </p>
            ) : cgpaPlan.required <= 0 ? (
              <p className="text-sm text-green-400">
                You have already secured a {target.toFixed(1)} CGPA. Even minimum
                passing grades keep you on target.
              </p>
            ) : cgpaPlan.required > 10 ? (
              <p className="text-sm text-red-400">
                A {target.toFixed(1)} CGPA is out of reach for one term in this
                plan \u2014 it would need an SGPA above 10 across {upcomingCredits}
                credits. Spread it over more semesters or lower the target.
              </p>
            ) : (
              <p className="text-sm text-gray-200">
                Score at least an SGPA of{" "}
                <span className="font-bold text-[#8b5cf6]">
                  {cgpaPlan.required.toFixed(2)}
                </span>{" "}
                (about a {gradeBand(cgpaPlan.required)} average) across your next{" "}
                {upcomingCredits} credits to reach a {target.toFixed(1)} CGPA.
              </p>
            )}
          </div>

          <p className="text-[11px] leading-relaxed text-gray-500">
            CGPA is credit-weighted: (current CGPA x completed credits + new SGPA
            x new credits) / total credits, on a 10-point scale.
          </p>
        </div>
      ) : null}

'''
s = s[:start] + NEW_GPA + s[end_start:]

open(f, "w", encoding="utf-8").write(s)

s2 = open(f, encoding="utf-8").read()
assert "ChevronDown" not in s2, "ChevronDown still referenced"
assert "cgpaPlan" in s2 and "Target CGPA Planner" in s2, "planner missing"
assert s2.count(chr(123) * 2) == 0, "double-open-brace present"
print("cgpa planner applied; integrity OK")
