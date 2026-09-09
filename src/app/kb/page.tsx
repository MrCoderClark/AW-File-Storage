import { redirect } from "next/navigation";

// The Knowledge base landing goes straight to the article list (spec 0025).
export default function KbIndex() {
  redirect("/kb/articles");
}
