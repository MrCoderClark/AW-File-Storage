"use client";

import ImageExt from "@tiptap/extension-image";
import LinkExt from "@tiptap/extension-link";
import { type Editor, EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";

// Admin editor for the help CMS (spec 0024, slice 2b). Owner/admin manage their org's
// articles; the platform owner additionally sees a "Share to all orgs" toggle. Rich text is
// authored with Tiptap and stored as HTML (sanitized server-side on save). Images are uploaded
// to R2 via the presigned route and embedded by their app-relative serve URL.

interface Article {
  id: string;
  title: string;
  slug: string;
  category: string;
  bodyHtml: string;
  excerpt: string | null;
  pageKey: string | null;
  status: "draft" | "published";
  shared: boolean;
  sortOrder: number;
}

export function HelpAdminSection() {
  const [articles, setArticles] = useState<Article[] | null>(null);
  const [canShare, setCanShare] = useState(false);
  const [error, setError] = useState(false);
  const [editing, setEditing] = useState<Article | "new" | null>(null);

  const load = useCallback(async () => {
    setError(false);
    try {
      const res = await fetch("/api/help/articles", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { articles: Article[]; canShare: boolean };
      setArticles(body.articles);
      setCanShare(body.canShare);
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (editing) {
    return (
      <ArticleEditor
        article={editing === "new" ? null : editing}
        canShare={canShare}
        onDone={() => {
          setEditing(null);
          void load();
        }}
        onCancel={() => setEditing(null)}
      />
    );
  }

  return (
    <section className="rounded-[--radius-panel] border border-border bg-surface">
      <div className="flex items-center justify-between border-b border-border p-4">
        <div>
          <h2 className="text-base font-semibold text-slate-800">Help articles</h2>
          <p className="text-xs text-muted-500">
            Written for your staff; shown in the header Help drawer and at /help.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setEditing("new")}
          className="rounded-[--radius-panel] bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-800"
        >
          New article
        </button>
      </div>

      {error ? (
        <div className="p-8 text-center text-sm text-muted-500">
          <p>Couldn&apos;t load articles.</p>
          <button
            type="button"
            onClick={() => void load()}
            className="mt-3 rounded-[--radius-panel] border border-border px-3 py-1 text-xs font-medium hover:bg-canvas"
          >
            Retry
          </button>
        </div>
      ) : articles === null ? (
        <p className="p-8 text-center text-sm text-muted-500">Loading…</p>
      ) : articles.length === 0 ? (
        <p className="p-8 text-center text-sm text-muted-500">
          No articles yet. Create your first one.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {articles.map((a) => (
            <li
              key={a.id}
              className="flex items-center justify-between gap-3 px-4 py-3"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-slate-800">
                    {a.title}
                  </span>
                  <StatusBadge status={a.status} />
                  {a.shared && (
                    <span className="rounded-full bg-brand-600/10 px-2 py-0.5 text-[11px] font-medium text-brand-600">
                      Shared
                    </span>
                  )}
                </div>
                <span className="text-xs text-muted-500">{a.category}</span>
              </div>
              <button
                type="button"
                onClick={() => setEditing(a)}
                className="shrink-0 rounded-[--radius-panel] border border-border px-3 py-1 text-xs font-medium hover:bg-canvas"
              >
                Edit
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ArticleEditor({
  article,
  canShare,
  onDone,
  onCancel,
}: {
  article: Article | null;
  canShare: boolean;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(article?.title ?? "");
  const [category, setCategory] = useState(article?.category ?? "General");
  const [slug, setSlug] = useState(article?.slug ?? "");
  const [pageKey, setPageKey] = useState(article?.pageKey ?? "");
  const [excerpt, setExcerpt] = useState(article?.excerpt ?? "");
  const [sortOrder, setSortOrder] = useState(article?.sortOrder ?? 0);
  const [shared, setShared] = useState(article?.shared ?? false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const editor = useEditor({
    immediatelyRender: false, // required under Next SSR
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
          "min-h-[16rem] rounded-b-[--radius-panel] border border-t-0 border-border bg-canvas p-4 text-sm leading-relaxed focus:outline-none",
      },
    },
  });

  async function save(status: "draft" | "published") {
    if (!editor) return;
    const t = title.trim();
    if (!t) {
      setErr("A title is required.");
      return;
    }
    setBusy(true);
    setErr(null);
    const payload = {
      title: t,
      slug: slug.trim() || undefined,
      category: category.trim() || "General",
      bodyHtml: editor.getHTML(),
      excerpt: excerpt.trim(),
      pageKey: pageKey.trim(),
      status,
      ...(canShare ? { shared } : {}),
      sortOrder,
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
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not save.");
      setBusy(false);
    }
  }

  async function remove() {
    if (!article) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/help/articles/${article.id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error();
      onDone();
    } catch {
      setErr("Could not delete.");
      setBusy(false);
      setConfirmDelete(false);
    }
  }

  async function onPickImage(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !editor) return;
    const url = await uploadImage(file);
    if (url) editor.chain().focus().setImage({ src: url }).run();
    else setErr("Image upload failed.");
  }

  return (
    <section className="rounded-[--radius-panel] border border-border bg-surface p-4">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-base font-semibold text-slate-800">
          {article ? "Edit article" : "New article"}
        </h2>
        <button
          type="button"
          onClick={onCancel}
          className="text-sm text-accent-500 hover:underline"
        >
          ← Back to list
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Title" className="sm:col-span-2">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="input"
            placeholder="e.g. Creating a contact card"
          />
        </Field>
        <Field label="Category">
          <input
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="input"
            placeholder="Getting started"
          />
        </Field>
        <Field label="Order">
          <input
            type="number"
            value={sortOrder}
            onChange={(e) => setSortOrder(Number(e.target.value) || 0)}
            className="input"
          />
        </Field>
        <Field label="Slug (optional)">
          <input
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            className="input"
            placeholder="auto from title"
          />
        </Field>
        <Field label="Page key (optional, for “For this page”)">
          <input
            value={pageKey}
            onChange={(e) => setPageKey(e.target.value)}
            className="input"
            placeholder="files, create-card, settings…"
          />
        </Field>
        <Field label="Excerpt (optional)" className="sm:col-span-2">
          <input
            value={excerpt}
            onChange={(e) => setExcerpt(e.target.value)}
            className="input"
            placeholder="A one-line summary shown in the list"
          />
        </Field>
      </div>

      <div className="mt-4">
        <span className="mb-1 block text-xs font-medium text-slate-700">Body</span>
        <Toolbar editor={editor} onImage={() => fileRef.current?.click()} />
        <EditorContent editor={editor} />
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          hidden
          onChange={onPickImage}
        />
      </div>

      {canShare && (
        <label className="mt-4 flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={shared}
            onChange={(e) => setShared(e.target.checked)}
          />
          Share to all organizations (platform-wide)
        </label>
      )}

      {err && <p className="mt-3 text-sm text-danger-600">{err}</p>}

      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-4">
        <button
          type="button"
          disabled={busy}
          onClick={() => void save("published")}
          className="rounded-[--radius-panel] bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-800 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Publish"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void save("draft")}
          className="rounded-[--radius-panel] border border-border px-4 py-2 text-sm font-medium text-slate-700 hover:bg-canvas disabled:opacity-50"
        >
          Save as draft
        </button>
        {article && (
          <button
            type="button"
            disabled={busy}
            onClick={() => setConfirmDelete(true)}
            className="ml-auto rounded-[--radius-panel] border border-border px-4 py-2 text-sm font-medium text-danger-600 hover:bg-canvas disabled:opacity-50"
          >
            Delete
          </button>
        )}
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title={`Delete “${article?.title ?? ""}”?`}
        body="This permanently removes the article and its images. This can't be undone."
        confirmLabel="Delete"
        danger
        busy={busy}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => void remove()}
      />

      <style>{`.input{width:100%;border-radius:var(--radius-panel);border:1px solid var(--color-border,#d7dfeb);background:var(--color-canvas,#f1f4f9);padding:0.5rem 0.75rem;font-size:0.875rem}`}</style>
    </section>
  );
}

async function uploadImage(file: File): Promise<string | null> {
  try {
    const res = await fetch("/api/help/images", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contentType: file.type }),
    });
    if (!res.ok) return null;
    const { uploadUrl, url } = (await res.json()) as {
      uploadUrl: string;
      url: string;
    };
    const put = await fetch(uploadUrl, {
      method: "PUT",
      body: file,
      headers: { "Content-Type": file.type },
    });
    return put.ok ? url : null;
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
    `rounded px-2 py-1 text-xs font-medium ${
      active ? "bg-brand-600 text-white" : "text-slate-700 hover:bg-canvas"
    }`;
  return (
    <div className="flex flex-wrap gap-1 rounded-t-[--radius-panel] border border-border bg-surface p-1.5">
      <button type="button" className={btn(editor.isActive("bold"))} onClick={() => editor.chain().focus().toggleBold().run()}>
        Bold
      </button>
      <button type="button" className={btn(editor.isActive("italic"))} onClick={() => editor.chain().focus().toggleItalic().run()}>
        Italic
      </button>
      <button type="button" className={btn(editor.isActive("heading", { level: 2 }))} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>
        H2
      </button>
      <button type="button" className={btn(editor.isActive("heading", { level: 3 }))} onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}>
        H3
      </button>
      <button type="button" className={btn(editor.isActive("bulletList"))} onClick={() => editor.chain().focus().toggleBulletList().run()}>
        • List
      </button>
      <button type="button" className={btn(editor.isActive("orderedList"))} onClick={() => editor.chain().focus().toggleOrderedList().run()}>
        1. List
      </button>
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
      <button type="button" className={btn(false)} onClick={onImage}>
        Image
      </button>
    </div>
  );
}

function Field({
  label,
  className = "",
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={`flex flex-col gap-1 ${className}`}>
      <span className="text-xs font-medium text-slate-700">{label}</span>
      {children}
    </label>
  );
}

function StatusBadge({ status }: { status: "draft" | "published" }) {
  return status === "published" ? (
    <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
      Published
    </span>
  ) : (
    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">
      Draft
    </span>
  );
}
