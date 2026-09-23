// ProjectBrowser.tsx - your projects, as a row of cards.
//
// dice used to hold exactly one project: a single autosave slot that whatever
// you did last quietly overwrote. This is the shelf. The first card makes a new
// one, and every other card opens, renames or throws away a saved project.
//
// Cards are drawn from summaries rather than from the projects themselves,
// because a project carries every recorded audio buffer with it and listing ten
// of them would pull tens of megabytes out of IndexedDB just to render ten
// names.

import { useCallback, useEffect, useState } from "react";
import {
  deleteProject,
  listProjects,
  renameProject,
  savedAgo,
  type ProjectSummary,
} from "./lib/projectStore";

export interface ProjectBrowserProps {
  /** Start a new, empty project. */
  onNew(): void;
  /** Open a saved project by id. */
  onOpen(id: string): void;
  /** Save what is open now; returns the id it was saved under. */
  onSave(): Promise<string | null>;
  /** The project currently open, so its card can be marked. */
  currentId: string | null;
  /** Bumped by the parent when a save happens, to refresh the shelf. */
  version: number;
}

export default function ProjectBrowser({
  onNew,
  onOpen,
  onSave,
  currentId,
  version,
}: ProjectBrowserProps) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");

  const refresh = useCallback(() => {
    listProjects()
      .then(setProjects)
      .catch(() => setError("Could not read your projects."));
  }, []);

  useEffect(refresh, [refresh, version]);

  const save = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const id = await onSave();
      if (!id) setError("There is nothing to save yet.");
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }, [onSave, refresh]);

  const commitRename = useCallback(
    async (id: string) => {
      const name = draft.trim();
      setRenaming(null);
      if (!name) return;
      await renameProject(id, name);
      refresh();
    },
    [draft, refresh]
  );

  const remove = useCallback(
    async (id: string, name: string) => {
      // Deleting a project throws away recordings that exist nowhere else, so
      // it asks first.
      if (!window.confirm(`Delete "${name}"? Its recordings go with it.`)) return;
      await deleteProject(id);
      refresh();
    },
    [refresh]
  );

  return (
    <section className="rounded-2xl border border-salmonDim/30 bg-maroon/40 p-4">
      <div className="mb-3 flex flex-wrap items-baseline gap-2">
        <h2 className="dice-display text-2xl text-chalk">your projects</h2>
        <span className="text-xs text-bone/45">
          {projects.length === 0
            ? "nothing saved yet"
            : `${projects.length} saved`}
        </span>
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="ml-auto rounded-lg bg-bone px-3 py-1.5 text-sm font-semibold text-maroonInk transition hover:bg-chalk disabled:opacity-50"
        >
          {busy ? "saving" : "save this one"}
        </button>
      </div>

      <div className="flex gap-3 overflow-x-auto pb-1">
        <button
          type="button"
          onClick={onNew}
          title="Start a new project"
          className="flex h-24 w-32 shrink-0 flex-col items-center justify-center rounded-xl border-2 border-salmonDim/40 text-bone/70 transition hover:border-salmon hover:bg-maroonDeep/60 hover:text-chalk"
        >
          <span className="text-3xl leading-none">+</span>
          <span className="mt-1 text-xs">new</span>
        </button>

        {projects.map((p) => {
          const open = p.id === currentId;
          return (
            <div
              key={p.id}
              className={`flex h-24 w-40 shrink-0 flex-col justify-between rounded-xl border p-2.5 transition ${
                open
                  ? "border-salmon bg-maroonDeep/70"
                  : "border-salmonDim/30 bg-maroonDeep/40 hover:bg-maroonDeep/70"
              }`}
            >
              {renaming === p.id ? (
                <input
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => commitRename(p.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                    if (e.key === "Escape") setRenaming(null);
                  }}
                  className="w-full rounded border border-salmonDim/40 bg-maroonInk/60 px-1.5 py-1 text-xs text-chalk"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => onOpen(p.id)}
                  className="min-w-0 text-left"
                >
                  <span className="block truncate text-sm font-semibold text-chalk">
                    {p.name}
                  </span>
                  <span className="mt-0.5 block text-[11px] text-bone/50">
                    {p.bpm} BPM · {p.tracks} track{p.tracks === 1 ? "" : "s"}
                  </span>
                  <span className="block text-[11px] text-bone/40">
                    {savedAgo(p.savedAt)}
                  </span>
                </button>
              )}

              <div className="flex items-center gap-1 text-[11px]">
                {open && <span className="mr-auto text-salmon">open</span>}
                <button
                  type="button"
                  onClick={() => {
                    setRenaming(p.id);
                    setDraft(p.name);
                  }}
                  className={`rounded px-1.5 py-0.5 text-salmon transition hover:bg-salmon/15 ${
                    open ? "" : "ml-auto"
                  }`}
                >
                  rename
                </button>
                <button
                  type="button"
                  onClick={() => remove(p.id, p.name)}
                  className="rounded px-1.5 py-0.5 text-live transition hover:bg-live/15"
                >
                  delete
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {error && <p className="mt-2 text-xs text-live">{error}</p>}
    </section>
  );
}
