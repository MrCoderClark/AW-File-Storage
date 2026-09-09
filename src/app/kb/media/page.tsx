import { MediaLibrary } from "@/components/kb/media-library";

// The Knowledge base media library (spec 0026). Admin/owner only (the /kb layout gates it).
export const dynamic = "force-dynamic";

export default function KbMediaPage() {
  return <MediaLibrary />;
}
