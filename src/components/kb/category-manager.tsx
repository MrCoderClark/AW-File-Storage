"use client";

import { useCallback, useEffect, useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";

// Manage the knowledge-base category tree (spec 0025). Create, rename, reparent, delete.
// Deleting reparents children to top-level and clears the category off any article (server-side).

interface Category {
  id: string;
  name: string;
  parentId: string | null;
  sortOrder: number;
}

export function CategoryManager() {
  const [cats, setCats] = useState<Category[] | null>(null);
  const [error, setError] = useState(false);
  const [newName, setNewName] = useState("");
  const [newParent, setNewParent] = useState("");
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<Category | null>(null);

  const load = useCallback(async () => {
    setError(false);
    try {
      const res = await fetch("/api/help/categories", { cache: "no-store" });
      if (!res.ok) throw new Error();
      const b = (await res.json()) as { categories: Category[] };
      setCats(b.categories);
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    await fetch("/api/help/categories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, parentId: newParent || undefined }),
    });
    setNewName("");
    setNewParent("");
    setBusy(false);
    void load();
  }

  async function patch(id: string, body: Record<string, unknown>) {
    await fetch(`/api/help/categories/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    void load();
  }

  async function remove(id: string) {
    setBusy(true);
    await fetch(`/api/help/categories/${id}`, { method: "DELETE" });
    setBusy(false);
    setDeleting(null);
    void load();
  }

  const tops = (cats ?? []).filter((c) => !c.parentId);

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-2xl font-bold text-brand-900">Categories</h1>
      <p className="mt-1 text-sm text-muted-500">
        Organize articles. Delete a category and its articles simply become uncategorized.
      </p>

      {/* New category */}
      <div className="mt-5 flex flex-col gap-2 rounded-[--radius-panel] border border-border bg-surface p-4 sm:flex-row sm:items-end">
        <label className="flex flex-1 flex-col gap-1">
          <span className="text-xs font-medium text-slate-700">New category</span>
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className="input"
            placeholder="e.g. Getting started"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-slate-700">Parent</span>
          <select
            value={newParent}
            onChange={(e) => setNewParent(e.target.value)}
            className="input"
          >
            <option value="">Top level</option>
            {tops.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={busy || !newName.trim()}
          onClick={() => void create()}
          className="rounded-[--radius-panel] bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-800 disabled:opacity-50"
        >
          Add
        </button>
      </div>

      {/* List */}
      <div className="mt-5 rounded-[--radius-panel] border border-border bg-surface">
        {error ? (
          <p className="p-6 text-center text-sm text-muted-500">
            Couldn&apos;t load categories.
          </p>
        ) : cats === null ? (
          <p className="p-6 text-center text-sm text-muted-500">Loading…</p>
        ) : cats.length === 0 ? (
          <p className="p-6 text-center text-sm text-muted-500">
            No categories yet.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {cats.map((c) => (
              <li
                key={c.id}
                className="flex flex-wrap items-center gap-2 px-4 py-3"
              >
                <input
                  defaultValue={c.name}
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    if (v && v !== c.name) void patch(c.id, { name: v });
                  }}
                  className="input flex-1"
                  aria-label={`Name for ${c.name}`}
                />
                <select
                  value={c.parentId ?? ""}
                  onChange={(e) => void patch(c.id, { parentId: e.target.value || null })}
                  className="input w-40"
                  aria-label={`Parent of ${c.name}`}
                >
                  <option value="">Top level</option>
                  {tops
                    .filter((t) => t.id !== c.id)
                    .map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                </select>
                <button
                  type="button"
                  onClick={() => setDeleting(c)}
                  className="rounded-[--radius-panel] border border-border px-3 py-1.5 text-xs font-medium text-danger-600 hover:bg-canvas"
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <ConfirmDialog
        open={deleting !== null}
        title={`Delete “${deleting?.name ?? ""}”?`}
        body="Its child categories move to top level and its articles become uncategorized."
        confirmLabel="Delete"
        danger
        busy={busy}
        onCancel={() => setDeleting(null)}
        onConfirm={() => deleting && void remove(deleting.id)}
      />

      <style>{`.input{border-radius:var(--radius-panel);border:1px solid var(--color-border);background:var(--color-canvas);padding:0.5rem 0.75rem;font-size:0.875rem;color:#0f172a}.input:focus{outline:none;border-color:var(--color-accent-500)}`}</style>
    </div>
  );
}
