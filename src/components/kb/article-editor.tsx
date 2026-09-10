"use client";

import LinkExt from "@tiptap/extension-link";
import { type Editor, EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { HelpArticleBody } from "@/components/help-article-body";
import { HELP_PAGE_KEYS } from "@/lib/help-page-keys";
import { uploadHelpImage } from "@/lib/help-image-upload";
import { AiDraftPanel, type AiDraft } from "./ai-draft-panel";
import { MediaPicker } from "./media-picker";
import type { MediaImage } from "./media-shared";
import { ResizableImage } from "./resizable-image";

// The Knowledge base article editor (spec 0025). Two columns: title + WYSIWYG body on the left,
// an "Article details" rail on the right (category, tags, audience, featured image, related,
// share). Save Draft / Publish in the header. The editor surface reuses `.help-content` so it
// matches the published page. Owner/admin; the platform owner also gets the share toggle.

export interface EditorArticle {
  id: string;
  title: string;
  slug: string;
  categoryId: string | null;
  tags: string; // JSON array
  featuredImageId: string | null;
  relatedIds: string; // JSON array
  audience: "all" | "admins";
  bodyHtml: string;
  excerpt: string | null;
  pageKey: string | null;
  status: "draft" | "published";
  shared: boolean;
  sortOrder: number;
}

interface Category {
  id: string;
  name: string;
  parentId: string | null;
}
interface ArticleRef {
  id: string;
  title: string;
}

function parseJsonArray(s: string | null | undefined): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function ArticleEditor({ article }: { article: EditorArticle | null }) {
  const router = useRouter();
  const [title, setTitle] = useState(article?.title ?? "");
  const [slug, setSlug] = useState(article?.slug ?? "");
  const [excerpt, setExcerpt] = useState(article?.excerpt ?? "");
  const [pageKey, setPageKey] = useState(article?.pageKey ?? "");
  const [sortOrder, setSortOrder] = useState(article?.sortOrder ?? 0);
  const [categoryId, setCategoryId] = useState(article?.categoryId ?? "");
  const [audience, setAudience] = useState<"all" | "admins">(
    article?.audience ?? "all",
  );
  const [tags, setTags] = useState<string[]>(parseJsonArray(article?.tags));
  const [tagDraft, setTagDraft] = useState("");
  const [relatedIds, setRelatedIds] = useState<string[]>(
    parseJsonArray(article?.relatedIds),
  );
  const [featuredImageId, setFeaturedImageId] = useState(
    article?.featuredImageId ?? "",
  );
  const [shared, setShared] = useState(article?.shared ?? false);

  const [categories, setCategories] = useState<Category[]>([]);
  const [others, setOthers] = useState<ArticleRef[]>([]);
  const [canShare, setCanShare] = useState(false);
  const [busy, setBusy] = useState<"draft" | "published" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Which flow the media picker is open for (spec 0026): a body image, the featured image, or closed.
  const [pickerFor, setPickerFor] = useState<null | "body" | "featured">(null);
  // Unsaved-changes tracking (spec 0026 polish). `dirty` is a pure comparison to the values the
  // article loaded with, so it is StrictMode-proof (no first-run flag to get flipped) and returns
  // to false if the author reverts an edit. Body edits are tracked separately via Tiptap.
  const [bodyDirty, setBodyDirty] = useState(false);
  const bodyReady = useRef(false);
  const leaving = useRef(false); // set just before an intentional post-save navigation
  // Live preview (spec 0026 polish): render the body with reader typography before publishing.
  const [preview, setPreview] = useState(false);
  // AI draft (spec 0027): the generate panel, and a draft held for the overwrite confirm.
  const [aiOpen, setAiOpen] = useState(false);
  const [pendingDraft, setPendingDraft] = useState<AiDraft | null>(null);
  // Saving must preserve the article's current status: "Save changes" on a published article
  // keeps it published (Ctrl/⌘-S too), so a plain save never unpublishes. Status only changes
  // via the explicit Publish / Unpublish actions.
  const isPublished = article?.status === "published";
  const primaryStatus: "draft" | "published" = isPublished ? "published" : "draft";
  // The normalized body HTML at load time. Tiptap reformats the stored HTML on load and fires
  // onUpdate for it, so we compare against this baseline (not the raw stored string) to avoid a
  // false "unsaved changes" before the author types anything.
  const bodyBaseline = useRef<string | null>(null);
  // Snapshot of the rail/details fields at load, to compare against for the dirty check.
  const initialFields = useRef({
    title: article?.title ?? "",
    slug: article?.slug ?? "",
    excerpt: article?.excerpt ?? "",
    categoryId: article?.categoryId ?? "",
    audience: (article?.audience ?? "all") as "all" | "admins",
    tags: parseJsonArray(article?.tags),
    relatedIds: parseJsonArray(article?.relatedIds),
    featuredImageId: article?.featuredImageId ?? "",
    sortOrder: article?.sortOrder ?? 0,
    pageKey: article?.pageKey ?? "",
    shared: article?.shared ?? false,
  });

  useEffect(() => {
    fetch("/api/help/categories", { cache: "no-store" })
      .then((r) =>
        r.ok
          ? (r.json() as Promise<{ categories?: Category[] }>)
          : Promise.reject(new Error()),
      )
      .then((b) => setCategories(b.categories ?? []))
      .catch(() => {});
    fetch("/api/help/articles", { cache: "no-store" })
      .then((r) =>
        r.ok
          ? (r.json() as Promise<{ articles?: ArticleRef[]; canShare?: boolean }>)
          : Promise.reject(new Error()),
      )
      .then((b) => {
        setOthers((b.articles ?? []).filter((a) => a.id !== article?.id));
        setCanShare(Boolean(b.canShare));
      })
      .catch(() => {});
  }, [article?.id]);

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      // Tiptap v3's StarterKit bundles its own Link; disable it so our configured LinkExt
      // (rel + no open-on-click) is the only link extension (avoids the duplicate-name warning).
      StarterKit.configure({ link: false }),
      LinkExt.configure({
        openOnClick: false,
        autolink: true,
        HTMLAttributes: { rel: "noopener noreferrer nofollow" },
      }),
      ResizableImage,
    ],
    content: article?.bodyHtml ?? "<p></p>",
    onCreate: ({ editor }) => {
      // Capture the baseline after ProseMirror finishes normalizing the loaded HTML (a macrotask
      // later), and ignore updates until then, so loading an article is never counted as an edit.
      bodyBaseline.current = editor.getHTML();
      setTimeout(() => {
        bodyBaseline.current = editor.getHTML();
        bodyReady.current = true;
      }, 0);
    },
    onUpdate: ({ editor }) => {
      if (!bodyReady.current) return;
      setBodyDirty(editor.getHTML() !== bodyBaseline.current);
    },
    editorProps: {
      attributes: {
        class:
          "help-content min-h-[22rem] rounded-b-[--radius-panel] border border-t-0 border-border bg-surface px-4 py-3 focus:outline-none",
      },
    },
  });

  function addTag() {
    const t = tagDraft.trim();
    if (t && !tags.includes(t)) setTags([...tags, t]);
    setTagDraft("");
  }

  async function save(status: "draft" | "published") {
    if (!editor || busy) return; // ignore re-entry (e.g. Ctrl-S key-repeat)
    const t = title.trim();
    if (!t) {
      setErr("A title is required.");
      return;
    }
    setBusy(status);
    setErr(null);
    const payload = {
      title: t,
      slug: slug.trim() || undefined,
      categoryId: categoryId || null,
      tags,
      featuredImageId: featuredImageId || null,
      relatedIds,
      audience,
      bodyHtml: editor.getHTML(),
      excerpt: excerpt.trim(),
      pageKey: pageKey.trim(),
      status,
      sortOrder,
      ...(canShare ? { shared } : {}),
    };
    try {
      const res = article
        ? await fetch(`/api/help/articles/${article.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          })
        : await fetch("/api/help/articles", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error ?? "Could not save.");
      }
      leaving.current = true; // so the guard doesn't warn on the post-save navigation
      // Navigate only; the list re-fetches on mount. Calling router.refresh() here would
      // refetch the RSC for the page we're leaving and race the navigation ("Failed to fetch
      // RSC payload for …/[id]").
      router.push("/kb/articles");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not save.");
      setBusy(null);
    }
  }

  async function remove() {
    if (!article) return;
    setBusy("draft");
    try {
      const res = await fetch(`/api/help/articles/${article.id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error();
      leaving.current = true;
      router.push("/kb/articles");
    } catch {
      setErr("Could not delete.");
      setBusy(null);
      setConfirmDelete(false);
    }
  }

  // Apply an AI draft into the editor. Confirm first if it would overwrite existing content.
  function applyDraft(draft: AiDraft) {
    setTitle(draft.title);
    setExcerpt(draft.excerpt);
    editor?.commands.setContent(draft.bodyHtml || "<p></p>");
    setBodyDirty(true);
  }
  function onAiDraft(draft: AiDraft) {
    setAiOpen(false);
    const hasContent =
      title.trim().length > 0 ||
      excerpt.trim().length > 0 ||
      (editor?.getText().trim().length ?? 0) > 0;
    if (hasContent) setPendingDraft(draft);
    else applyDraft(draft);
  }

  // The media picker returns a chosen (or freshly uploaded) library image. Insert it into the
  // body with its alt text, or set it as the featured image, depending on which flow is open.
  function onPickImage(img: MediaImage) {
    if (pickerFor === "body" && editor) {
      editor
        .chain()
        .focus()
        .setImage({ src: img.url, alt: img.altText ?? "" })
        .run();
    } else if (pickerFor === "featured") {
      setFeaturedImageId(img.id);
    }
    setPickerFor(null);
  }

  // Dirty = any field differs from what the article loaded with, or the body changed. A pure
  // comparison (no effects/flags), so it is correct on first paint and reverts to false when an
  // edit is undone.
  const init = initialFields.current;
  const fieldsDirty =
    title !== init.title ||
    slug !== init.slug ||
    excerpt !== init.excerpt ||
    categoryId !== init.categoryId ||
    audience !== init.audience ||
    featuredImageId !== init.featuredImageId ||
    sortOrder !== init.sortOrder ||
    pageKey !== init.pageKey ||
    shared !== init.shared ||
    tags.join("") !== init.tags.join("") ||
    relatedIds.join("") !== init.relatedIds.join("");
  const dirty = fieldsDirty || bodyDirty;

  // Warn before the browser unloads (refresh / close / external nav) with unsaved edits — unless
  // we are intentionally navigating away right after a save.
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      if (leaving.current) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  // Guard IN-APP navigation too (Next Link clicks: the KB sidebar, breadcrumb, "Back to app").
  // beforeunload never fires for those, so intercept the click in the capture phase and confirm
  // before letting the router navigate. Links inside the editor body and external links are left
  // alone.
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: MouseEvent) => {
      if (leaving.current || e.defaultPrevented || e.button !== 0) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; // open-in-new-tab etc.
      const anchor = (e.target as HTMLElement | null)?.closest?.("a[href]");
      if (!anchor) return;
      if (anchor.closest(".ProseMirror")) return; // a link inside the article body
      const href = anchor.getAttribute("href") ?? "";
      if (!href.startsWith("/")) return; // only in-app routes
      if (anchor.getAttribute("target") === "_blank") return;
      if (!window.confirm("You have unsaved changes. Leave without saving?")) {
        e.preventDefault();
        e.stopPropagation();
      } else {
        leaving.current = true; // allow this navigation (and skip beforeunload)
      }
    };
    document.addEventListener("click", handler, true);
    return () => document.removeEventListener("click", handler, true);
  }, [dirty]);

  // Ctrl/Cmd-S saves a draft (only when there are unsaved changes). Refs keep the handler
  // pointed at the latest save closure and dirty flag without re-subscribing each render.
  const saveRef = useRef(save);
  saveRef.current = save;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        // Preserve status: never unpublish a published article on Ctrl/⌘-S.
        if (dirtyRef.current) void saveRef.current(primaryStatus);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  return (
    <div>
      <nav className="text-sm text-muted-500">
        <a href="/kb/articles" className="text-accent-500 hover:underline">
          Articles
        </a>{" "}
        · {article ? "Edit" : "New"}
      </nav>

      <div className="mt-2 mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-brand-900">
            {article ? "Edit article" : "Create help article"}
          </h1>
          <p className="text-sm text-muted-500">
            Write and publish a help article for your staff.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => setAiOpen(true)}
            className="rounded-[--radius-panel] border border-accent-500 bg-surface px-3 py-2 text-sm font-medium text-accent-500 hover:bg-accent-500/5 disabled:opacity-50"
          >
            ✨ Generate with AI
          </button>

          {/* Publish toggle: Publish a draft, or Unpublish a published article. Persists the
              current edits as it flips the status. */}
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void save(isPublished ? "draft" : "published")}
            className="rounded-[--radius-panel] border border-brand-600 bg-surface px-4 py-2 text-sm font-semibold text-brand-600 hover:bg-canvas disabled:opacity-50"
          >
            {isPublished ? "Unpublish" : "Publish"}
          </button>

          {/* Save — the obvious action. Greyed out when there is nothing to save; solid and
              gently pulsing when there are unsaved edits. Keeps the current status. */}
          <button
            type="button"
            disabled={busy !== null || !dirty}
            onClick={() => void save(primaryStatus)}
            title={dirty ? "Save (Ctrl/⌘+S)" : "No changes to save"}
            className={`rounded-[--radius-panel] px-5 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed ${
              dirty
                ? "help-save-pulse bg-brand-600 text-white hover:bg-brand-800"
                : "bg-slate-100 text-muted-500"
            }`}
          >
            {busy !== null ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      {err && (
        <p className="mb-4 rounded-[--radius-panel] border border-danger-600/30 bg-danger-600/5 px-3 py-2 text-sm text-danger-600">
          {err}
        </p>
      )}

      <div className="flex flex-col gap-6 lg:flex-row">
        {/* Main column */}
        <div className="min-w-0 flex-1 space-y-4">
          <Field label="Title">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="input text-base"
              placeholder="e.g. Creating a contact card"
            />
          </Field>
          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs font-medium text-slate-700">Body</span>
              <div className="inline-flex overflow-hidden rounded-[--radius-panel] border border-border text-xs">
                <button
                  type="button"
                  onClick={() => setPreview(false)}
                  aria-pressed={!preview}
                  className={`px-2.5 py-1 font-medium ${!preview ? "bg-brand-600 text-white" : "bg-surface text-muted-500 hover:bg-canvas"}`}
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => setPreview(true)}
                  aria-pressed={preview}
                  className={`px-2.5 py-1 font-medium ${preview ? "bg-brand-600 text-white" : "bg-surface text-muted-500 hover:bg-canvas"}`}
                >
                  Preview
                </button>
              </div>
            </div>
            {preview ? (
              <div className="rounded-[--radius-panel] border border-border bg-surface px-4 py-3">
                {title.trim() && (
                  <h1 className="text-2xl font-bold tracking-tight text-brand-900">
                    {title.trim()}
                  </h1>
                )}
                {excerpt.trim() && (
                  <p className="mt-1.5 text-lg text-muted-500">{excerpt.trim()}</p>
                )}
                <HelpArticleBody html={editor?.getHTML() ?? ""} />
              </div>
            ) : (
              <>
                <Toolbar editor={editor} onImage={() => setPickerFor("body")} />
                <EditorContent editor={editor} />
              </>
            )}
          </div>
        </div>

        {/* Details rail */}
        <aside className="w-full shrink-0 space-y-4 lg:w-72">
          <div className="space-y-4 rounded-[--radius-panel] border border-border bg-surface p-4">
            <h2 className="text-sm font-semibold text-slate-800">Article details</h2>

            <Field label="Category">
              <select
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
                className="input"
              >
                <option value="">Uncategorized</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.parentId ? "— " : ""}
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>

            <div>
              <span className="mb-1 block text-xs font-medium text-slate-700">
                Tags
              </span>
              {tags.length > 0 && (
                <div className="mb-1 flex flex-wrap gap-1">
                  {tags.map((t) => (
                    <span
                      key={t}
                      className="inline-flex items-center gap-1 rounded-full bg-brand-600/10 px-2 py-0.5 text-xs text-brand-600"
                    >
                      {t}
                      <button
                        type="button"
                        aria-label={`Remove ${t}`}
                        onClick={() => setTags(tags.filter((x) => x !== t))}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <input
                value={tagDraft}
                onChange={(e) => setTagDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === ",") {
                    e.preventDefault();
                    addTag();
                  }
                }}
                onBlur={addTag}
                className="input"
                placeholder="Add a tag, press Enter"
              />
            </div>

            <Field label="Audience">
              <select
                value={audience}
                onChange={(e) =>
                  setAudience(e.target.value === "admins" ? "admins" : "all")
                }
                className="input"
              >
                <option value="all">All members</option>
                <option value="admins">Admins only</option>
              </select>
            </Field>

            <div>
              <span className="mb-1 block text-xs font-medium text-slate-700">
                Featured image
              </span>
              {featuredImageId ? (
                <div className="space-y-1">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`/api/help/images/${featuredImageId}`}
                    alt="Featured"
                    className="w-full rounded-[--radius-panel] border border-border"
                  />
                  <button
                    type="button"
                    onClick={() => setFeaturedImageId("")}
                    className="text-xs text-danger-600 hover:underline"
                  >
                    Remove
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setPickerFor("featured")}
                  className="w-full rounded-[--radius-panel] border border-dashed border-border py-4 text-xs text-muted-500 hover:bg-canvas"
                >
                  Choose or upload
                </button>
              )}
            </div>
          </div>

          {/* Related + meta + share */}
          <div className="space-y-4 rounded-[--radius-panel] border border-border bg-surface p-4">
            <div>
              <span className="mb-1 block text-xs font-medium text-slate-700">
                Related articles
              </span>
              {others.length === 0 ? (
                <p className="text-xs text-muted-500">No other articles yet.</p>
              ) : (
                <div className="max-h-40 space-y-1 overflow-y-auto rounded-[--radius-panel] border border-border p-2">
                  {others.map((o) => (
                    <label
                      key={o.id}
                      className="flex items-center gap-2 text-sm text-slate-700"
                    >
                      <input
                        type="checkbox"
                        checked={relatedIds.includes(o.id)}
                        onChange={(e) =>
                          setRelatedIds(
                            e.target.checked
                              ? [...relatedIds, o.id]
                              : relatedIds.filter((x) => x !== o.id),
                          )
                        }
                      />
                      <span className="truncate">{o.title}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
            <Field label="Slug (optional)">
              <input
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                className="input"
                placeholder="auto from title"
              />
            </Field>
            <Field label="Excerpt">
              <textarea
                value={excerpt}
                onChange={(e) => setExcerpt(e.target.value)}
                rows={2}
                className="input resize-none"
                placeholder="One-line summary shown in lists"
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Order">
                <input
                  type="number"
                  value={sortOrder}
                  onChange={(e) => setSortOrder(Number(e.target.value) || 0)}
                  className="input"
                />
              </Field>
              <Field label="Show on page">
                <select
                  value={pageKey}
                  onChange={(e) => setPageKey(e.target.value)}
                  className="input"
                >
                  <option value="">General (all pages)</option>
                  {HELP_PAGE_KEYS.map((p) => (
                    <option key={p.key} value={p.key}>
                      {p.label}
                    </option>
                  ))}
                  {/* Preserve a legacy free-text key that isn't a known route. */}
                  {pageKey && !HELP_PAGE_KEYS.some((p) => p.key === pageKey) && (
                    <option value={pageKey}>{pageKey}</option>
                  )}
                </select>
              </Field>
            </div>
            {canShare && (
              <label className="flex items-start gap-2 border-t border-border pt-3 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={shared}
                  onChange={(e) => setShared(e.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  Share to all organizations
                  <span className="block text-xs text-muted-500">
                    Shows in every org&apos;s help.
                  </span>
                </span>
              </label>
            )}
            {article && (
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => setConfirmDelete(true)}
                className="w-full border-t border-border pt-3 text-left text-sm font-medium text-danger-600 hover:underline disabled:opacity-50"
              >
                Delete article
              </button>
            )}
          </div>
        </aside>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title={`Delete “${article?.title ?? ""}”?`}
        body="This permanently removes the article and its images. This can't be undone."
        confirmLabel="Delete"
        danger
        busy={busy !== null}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => void remove()}
      />

      {aiOpen && (
        <AiDraftPanel onApply={onAiDraft} onClose={() => setAiOpen(false)} />
      )}

      <ConfirmDialog
        open={pendingDraft !== null}
        title="Replace with the AI draft?"
        body="This replaces the current title, excerpt, and body with the generated draft. You can still edit before saving."
        confirmLabel="Replace"
        onCancel={() => setPendingDraft(null)}
        onConfirm={() => {
          if (pendingDraft) applyDraft(pendingDraft);
          setPendingDraft(null);
        }}
      />

      {pickerFor && (
        <MediaPicker
          title={pickerFor === "featured" ? "Featured image" : "Insert image"}
          onSelect={onPickImage}
          onClose={() => setPickerFor(null)}
        />
      )}

      <style>{`.input{width:100%;border-radius:var(--radius-panel);border:1px solid var(--color-border);background:var(--color-canvas);padding:0.5rem 0.75rem;font-size:0.875rem;color:#0f172a}.input:focus{outline:none;border-color:var(--color-accent-500);box-shadow:0 0 0 2px color-mix(in srgb,var(--color-accent-500) 25%,transparent)}`}</style>
    </div>
  );
}

function Toolbar({
  editor,
  onImage,
}: {
  editor: Editor | null;
  onImage: () => void;
}) {
  if (!editor) return null;
  const btn = (active: boolean) =>
    `rounded px-2 py-1 text-xs font-medium transition-colors ${
      active ? "bg-brand-600 text-white" : "text-slate-700 hover:bg-canvas"
    }`;
  const Divider = () => <span className="mx-1 h-5 w-px bg-border" aria-hidden />;
  return (
    <div className="flex flex-wrap items-center gap-0.5 rounded-t-[--radius-panel] border border-border bg-canvas p-1.5">
      <button type="button" className={btn(editor.isActive("bold"))} onClick={() => editor.chain().focus().toggleBold().run()}>Bold</button>
      <button type="button" className={btn(editor.isActive("italic"))} onClick={() => editor.chain().focus().toggleItalic().run()}>Italic</button>
      <Divider />
      <button type="button" className={btn(editor.isActive("heading", { level: 2 }))} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>H2</button>
      <button type="button" className={btn(editor.isActive("heading", { level: 3 }))} onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}>H3</button>
      <Divider />
      <button type="button" className={btn(editor.isActive("bulletList"))} onClick={() => editor.chain().focus().toggleBulletList().run()}>• List</button>
      <button type="button" className={btn(editor.isActive("orderedList"))} onClick={() => editor.chain().focus().toggleOrderedList().run()}>1. List</button>
      <button type="button" className={btn(editor.isActive("blockquote"))} onClick={() => editor.chain().focus().toggleBlockquote().run()}>Quote</button>
      <button type="button" className={btn(editor.isActive("codeBlock"))} onClick={() => editor.chain().focus().toggleCodeBlock().run()}>Code</button>
      <Divider />
      <button
        type="button"
        className={btn(editor.isActive("link"))}
        onClick={() => {
          const prev = editor.getAttributes("link").href as string | undefined;
          const href = window.prompt("Link URL (https://…)", prev ?? "https://");
          if (href === null) return;
          if (href === "") editor.chain().focus().unsetLink().run();
          else editor.chain().focus().setLink({ href }).run();
        }}
      >
        Link
      </button>
      <button type="button" className={btn(false)} onClick={onImage}>Image</button>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-slate-700">{label}</span>
      {children}
    </label>
  );
}
