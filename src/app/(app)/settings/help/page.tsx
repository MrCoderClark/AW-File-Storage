import { redirect } from "next/navigation";

// Authoring moved out of Settings into the dedicated Knowledge base area (spec 0025).
// Keep this path working by redirecting anyone (or an old bookmark) to /kb.
export default function HelpSettingsRedirect() {
  redirect("/kb");
}
