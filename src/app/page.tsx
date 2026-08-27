import { redirect } from "next/navigation";

// The app has no marketing home; send visitors into the app (the (app) layout
// bounces anonymous callers to sign-in).
export default function Home() {
  redirect("/upload-center");
}
