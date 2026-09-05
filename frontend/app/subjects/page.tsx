import { redirect } from "next/navigation";

// Subjects moved into /schedule as a tab so the bottom nav could give its slot
// to Buddy. Existing bookmarks, push-notification deep links and the install
// prompt's shortcuts all still point here, so keep the route alive.
export default function SubjectsPage() {
  redirect("/schedule?tab=subjects");
}
