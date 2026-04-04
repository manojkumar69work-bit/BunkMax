export function convertERPText(text: string) {
  const lines = text
    .split("\n")
    .map(l => l.trim())
    .filter(Boolean);

  const percentageMap: Record<string, number> = {};
  const sessionMap: Record<string, number> = {};

  // Extract percentages
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes("%")) {
      const percentage = parseFloat(lines[i].replace("%", ""));
      const subject = lines[i - 1];
      percentageMap[subject] = percentage;
    }
  }

  // Extract sessions
  let inSession = false;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes("Course Wise Sessions List")) {
      inSession = true;
      continue;
    }

    if (!inSession) continue;

    if (
      lines[i].includes("|") &&
      lines[i + 2] &&
      !isNaN(Number(lines[i + 2]))
    ) {
      const subjectName =
        lines[i].split("|")[1]?.trim() || lines[i];
      const total = Number(lines[i + 2]);

      sessionMap[subjectName] = total;
    }
  }

  // Convert to backend format
  const subjects: any[] = [];
  const attendance: any = {};

  Object.keys(percentageMap).forEach((subject, index) => {
    const percentage = percentageMap[subject];

    const sessionKey = Object.keys(sessionMap).find(key =>
      key.toLowerCase().includes(subject.toLowerCase().split(" ")[0])
    );

    if (!sessionKey) return;

    const total = sessionMap[sessionKey];
    const attended = Math.round((percentage / 100) * total);

    const id = String(index + 1);

    subjects.push({
      subjectid: id,
      subject_name: subject,
      subject_type: "Theory"
    });

    attendance[id] = {
      totalsessions: total,
      presentSessionsCount: attended,
      percentage: percentage
    };
  });

  return { subjects, attendance };
}