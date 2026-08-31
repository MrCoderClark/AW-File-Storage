import { redirect } from "next/navigation";

// /settings has no content of its own now — send it to the first section.
export const dynamic = "force-dynamic";

export default function SettingsIndexPage() {
  redirect("/settings/profile");
}
