// The app's top-level routes a help article can be pinned to (spec 0025 follow-up), so the
// header Help drawer's "For this page" list matches the current route. The drawer derives the
// same key from the path (help-drawer.tsx `pageKeyFromPath` = first path segment), so these
// keys MUST be the exact `(app)` route segments. Keep in sync with the (app) route group and the
// primary nav (app-nav.tsx). Labels mirror the nav wording where a page appears there.

export interface HelpPageKey {
  /** The route segment stored on help_article.page_key (e.g. "upload-center"). */
  key: string;
  /** Human label shown in the editor's page-key picker. */
  label: string;
}

export const HELP_PAGE_KEYS: readonly HelpPageKey[] = [
  { key: "dashboard", label: "Dashboard" },
  { key: "upload-center", label: "Upload Center" },
  { key: "files", label: "Files" },
  { key: "create-card", label: "Create Card" },
  { key: "signature", label: "Email Signature" },
  { key: "activity", label: "Activity Logs" },
  { key: "settings", label: "Settings" },
];

/** The friendly label for a stored page key, or the raw key when it isn't a known route. */
export function helpPageKeyLabel(key: string): string {
  return HELP_PAGE_KEYS.find((p) => p.key === key)?.label ?? key;
}
