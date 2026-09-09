"use client";

import ImageExt from "@tiptap/extension-image";
import LinkExt from "@tiptap/extension-link";
import { type Editor, EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";

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
  const bodyFileRef = useRef<HTMLInputElement>(null);
  const featFileRef = useRef<HTMLInputElement>(null);

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
      StarterKit,
      LinkExt.configure({
        openOnClick: false,
        autolink: true,
        HTMLAttributes: { rel: "noopener noreferrer nofollow" },
      }),
      ImageExt,
    ],
    content: article?.bodyHtml ?? "<p></p>",
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
    if (!editor) return;
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
      router.push("/kb/articles");
      router.refresh();
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
      router.push("/kb/articles");
      router.refresh();
    } catch {
      setErr("Could not delete.");
      setBusy(null);
      setConfirmDelete(false);
    }
  }

  async function onBodyImage(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !editor) return;
    const up = await uploadImage(file, article?.id);
    if (up) editor.chain().focus().setImage({ src: up.url }).run();
    else setErr("Image upload failed.");
  }

  async function onFeatured(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const up = await uploadImage(file, article?.id);
    if (up) setFeaturedImageId(up.imageId);
    else setErr("Featured image upload failed.");
  }

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
        <div className="flex gap-2">
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void save("draft")}
            className="rounded-[--radius-panel] border border-border bg-surface px-4 py-2 text-sm font-medium text-slate-700 hover:bg-canvas disabled:opacity-50"
          >
            {busy === "draft" ? "Saving…" : "Save draft"}
          </button>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void save("published")}
            className="rounded-[--radius-panel] bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-800 disabled:opacity-50"
          >
            {busy === "published" ? "Publishing…" : "Publish"}
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
            <span className="mb-1 block text-xs font-medium text-slate-700">
              Body
            </span>
            <Toolbar editor={editor} onImage={() => bodyFileRef.current?.click()} />
            <EditorContent editor={editor} />
            <input
              ref={bodyFileRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              hidden
              onChange={onBodyImage}
            />
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
                  onClick={() => featFileRef.current?.click()}
                  className="w-full rounded-[--radius-panel] border border-dashed border-border py-4 text-xs text-muted-500 hover:bg-canvas"
                >
                  Click to upload
                </button>
              )}
              <input
                ref={featFileRef}
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                hidden
                onChange={onFeatured}
              />
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
              <Field label="Page key">
                <input
                  value={pageKey}
                  onChange={(e) => setPageKey(e.target.value)}
                  className="input"
                  placeholder="files…"
                />
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

      <style>{`.input{width:100%;border-radius:var(--radius-panel);border:1px solid var(--color-border);background:var(--color-canvas);padding:0.5rem 0.75rem;font-size:0.875rem;color:#0f172a}.input:focus{outline:none;border-color:var(--color-accent-500);box-shadow:0 0 0 2px color-mix(in srgb,var(--color-accent-500) 25%,transparent)}`}</style>
    </div>
  );
}

async function uploadImage(
  file: File,
  articleId?: string,
): Promise<{ imageId: string; url: string } | null> {
  try {
    const res = await fetch("/api/help/images", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contentType: file.type, articleId }),
    });
    if (!res.ok) return null;
    const { imageId, uploadUrl, url } = (await res.json()) as {
      imageId: string;
      uploadUrl: string;
      url: string;
    };
    const put = await fetch(uploadUrl, {
      method: "PUT",
      body: file,
      headers: { "Content-Type": file.type },
    });
    return put.ok ? { imageId, url } : null;
  } catch {
    return null;
  }
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
