"use client";

import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import {
  createPictureGroup,
  deletePictureFromGroup,
  deletePictureGroup,
  fetchPictureLibrary,
  renamePictureGroup,
  savePictureLibrary,
  updatePictureCaption,
  uploadPictureToGroup,
  type PictureLibraryGroup,
  type PictureLibraryImage,
} from "@/lib/pictureLibrary";
import {
  clearLocalPictureLibrary,
  loadLocalPictureLibrary,
} from "@/lib/pictureLibraryLocal";

export type PictureLibraryPanelProps = {
  /** Insert a hosted image URL into the email body at the last cursor position. */
  onInsert: (url: string, filename: string) => void;
  disabled?: boolean;
  className?: string;
};

function formatSize(bytes: number): string {
  if (!bytes || bytes < 1024) return `${bytes || 0} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function applyGroups(
  next: PictureLibraryGroup[],
  setGroups: Dispatch<SetStateAction<PictureLibraryGroup[]>>,
  setActiveGroupId: Dispatch<SetStateAction<string>>,
) {
  setGroups(next);
  setActiveGroupId((prev) => {
    if (prev && next.some((g) => g.id === prev)) return prev;
    return next[0]?.id || "";
  });
}

export function PictureLibraryPanel({
  onInsert,
  disabled = false,
  className = "",
}: PictureLibraryPanelProps) {
  const [groups, setGroups] = useState<PictureLibraryGroup[]>([]);
  const [activeGroupId, setActiveGroupId] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [savedHint, setSavedHint] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newGroupName, setNewGroupName] = useState("");
  const [pictureSearch, setPictureSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const searchWrapRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    setError(null);
    const local = loadLocalPictureLibrary();
    try {
      const remote = await fetchPictureLibrary();
      if ((remote.groups || []).length) {
        // Server is source of truth — never resurrect deleted local leftovers.
        applyGroups(remote.groups, setGroups, setActiveGroupId);
        clearLocalPictureLibrary();
        setDirty(false);
      } else if (local.groups.length) {
        // Migrate old browser-only libraries: show them and ask user to Save.
        applyGroups(local.groups, setGroups, setActiveGroupId);
        setDirty(true);
        setSavedHint(
          "Pictures were only on this browser before. Click Save library to share them with everyone (any PC / incognito).",
        );
      } else {
        applyGroups([], setGroups, setActiveGroupId);
        setDirty(false);
      }
    } catch (e) {
      if (local.groups.length) {
        applyGroups(local.groups, setGroups, setActiveGroupId);
        setDirty(true);
        setError(
          (e instanceof Error ? e.message : "Could not reach shared library") +
            " — showing this browser’s draft. Click Save library when the API is back.",
        );
      } else {
        setError(e instanceof Error ? e.message : "Could not load picture library");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const activeGroup = groups.find((g) => g.id === activeGroupId) || null;
  const activeImages = activeGroup?.images || [];
  const searchNeedle = pictureSearch.trim().toLowerCase();
  const filteredImages = searchNeedle
    ? activeImages.filter((img) => {
        const caption = (img.caption || "").toLowerCase();
        const filename = (img.filename || "").toLowerCase();
        return caption.includes(searchNeedle) || filename.includes(searchNeedle);
      })
    : activeImages;

  useEffect(() => {
    function onDocMouseDown(e: MouseEvent) {
      if (!searchWrapRef.current?.contains(e.target as Node)) {
        setSearchOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, []);

  async function handleCreateGroup() {
    const name = newGroupName.trim();
    if (!name || busy) return;
    setBusy(true);
    setError(null);
    try {
      const row = await createPictureGroup(name);
      const next = [...groups.filter((g) => g.id !== row.id), row];
      applyGroups(next, setGroups, setActiveGroupId);
      setNewGroupName("");
      setDirty(false);
      setSavedHint("Group created on shared library.");
      window.setTimeout(() => setSavedHint(null), 4000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create group");
    } finally {
      setBusy(false);
    }
  }

  async function handleRenameGroup() {
    if (!activeGroup || busy) return;
    const name = window.prompt("Rename group", activeGroup.name)?.trim();
    if (!name || name === activeGroup.name) return;
    setBusy(true);
    setError(null);
    try {
      await renamePictureGroup(activeGroup.id, name);
      setGroups((prev) =>
        prev.map((g) => (g.id === activeGroup.id ? { ...g, name } : g)),
      );
      setDirty(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not rename group");
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteGroup() {
    if (!activeGroup || busy) return;
    if (
      !window.confirm(
        `Delete group “${activeGroup.name}” and remove its pictures from the shared library?`,
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await deletePictureGroup(activeGroup.id);
      const next = groups.filter((g) => g.id !== activeGroup.id);
      applyGroups(next, setGroups, setActiveGroupId);
      clearLocalPictureLibrary();
      setDirty(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete group");
    } finally {
      setBusy(false);
    }
  }

  async function handleUpload(files: FileList | null) {
    if (!activeGroup || !files?.length || busy || disabled) return;
    setBusy(true);
    setError(null);
    try {
      const added: PictureLibraryImage[] = [];
      const failures: string[] = [];
      for (const file of Array.from(files)) {
        if (!file.type.startsWith("image/")) continue;
        try {
          const img = await uploadPictureToGroup(activeGroup.id, file);
          added.push(img);
        } catch (e) {
          failures.push(
            `${file.name}: ${e instanceof Error ? e.message : "upload failed"}`,
          );
        }
      }
      if (!added.length) {
        setError(failures[0] || "No images uploaded to the shared library");
        return;
      }
      setGroups((prev) =>
        prev.map((g) => {
          if (g.id !== activeGroup.id) return g;
          const byId = new Map((g.images || []).map((i) => [i.id, i]));
          for (const img of added) byId.set(img.id, img);
          return { ...g, images: Array.from(byId.values()) };
        }),
      );
      setDirty(false);
      setSavedHint(
        failures.length
          ? `Uploaded ${added.length}; some failed (shared save skipped for those).`
          : `Uploaded ${added.length} picture(s) to the shared library.`,
      );
      window.setTimeout(() => setSavedHint(null), 5000);
      if (failures.length) setError(failures.join(" · "));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteImage(img: PictureLibraryImage) {
    if (!activeGroup || busy) return;
    const label = (img.caption || "").trim() || img.filename || "this picture";
    if (!window.confirm(`Remove “${label}” from the shared library?`)) return;
    setBusy(true);
    setError(null);
    try {
      await deletePictureFromGroup(activeGroup.id, img.id);
      setGroups((prev) =>
        prev.map((g) =>
          g.id === activeGroup.id
            ? { ...g, images: (g.images || []).filter((i) => i.id !== img.id) }
            : g,
        ),
      );
      clearLocalPictureLibrary();
      setDirty(false);
      setSavedHint("Removed from shared library — other browsers will see this after refresh.");
      window.setTimeout(() => setSavedHint(null), 4000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not remove picture");
    } finally {
      setBusy(false);
    }
  }

  async function handleSave() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const library = await savePictureLibrary(groups);
      applyGroups(library.groups || [], setGroups, setActiveGroupId);
      clearLocalPictureLibrary();
      setDirty(false);
      setSavedHint(
        "Saved to shared library — available on any PC, browser, or incognito after login.",
      );
      window.setTimeout(() => setSavedHint(null), 6000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save shared library");
    } finally {
      setBusy(false);
    }
  }

  function setCaptionLocal(imageId: string, caption: string) {
    setGroups((prev) =>
      prev.map((g) =>
        g.id !== activeGroupId
          ? g
          : {
              ...g,
              images: (g.images || []).map((i) =>
                i.id === imageId ? { ...i, caption } : i,
              ),
            },
      ),
    );
    setDirty(true);
  }

  async function commitCaption(img: PictureLibraryImage, caption: string) {
    if (!activeGroup) return;
    const cleaned = caption.trim();
    setGroups((prev) =>
      prev.map((g) =>
        g.id !== activeGroup.id
          ? g
          : {
              ...g,
              images: (g.images || []).map((i) =>
                i.id === img.id ? { ...i, caption: cleaned } : i,
              ),
            },
      ),
    );
    try {
      await updatePictureCaption(activeGroup.id, img.id, cleaned);
      setDirty(false);
    } catch {
      setDirty(true);
      setError("Caption saved on this screen only — click Save library to share it.");
    }
  }

  function insertImage(img: PictureLibraryImage) {
    if (disabled) return;
    onInsert(img.url, img.filename || "image");
  }

  function pickFromSearch(img: PictureLibraryImage) {
    insertImage(img);
    setPictureSearch((img.caption || "").trim());
    setSearchOpen(false);
  }

  return (
    <aside className={`picture-library ${className}`.trim()} aria-label="Picture library">
      <div className="picture-library-head">
        <h3>Picture library</h3>
        <p className="muted small">
          Shared for all users on any PC or browser (including incognito). Pick a group, search
          or click a picture to paste it into the email. Use Save library to publish changes for
          everyone.
        </p>
      </div>

      <div className="picture-library-browse">
        <label className="small muted" htmlFor="picture-library-group">
          Groups
        </label>
        <select
          id="picture-library-group"
          value={activeGroupId}
          disabled={loading || !groups.length}
          onChange={(e) => {
            setActiveGroupId(e.target.value);
            setPictureSearch("");
            setSearchOpen(false);
          }}
        >
          {!groups.length ? <option value="">No groups yet</option> : null}
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name} ({g.images?.length || 0})
            </option>
          ))}
        </select>

        <label className="small muted" htmlFor="picture-library-search">
          Search pictures
        </label>
        <div className="picture-library-search" ref={searchWrapRef}>
          <input
            id="picture-library-search"
            type="search"
            value={pictureSearch}
            disabled={loading || !activeGroup || !activeImages.length}
            placeholder="Type to find by label…"
            autoComplete="off"
            onChange={(e) => {
              setPictureSearch(e.target.value);
              setSearchOpen(true);
            }}
            onFocus={() => setSearchOpen(true)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setSearchOpen(false);
                return;
              }
              if (e.key === "Enter" && filteredImages[0]) {
                e.preventDefault();
                pickFromSearch(filteredImages[0]);
              }
            }}
          />
          {searchOpen && activeGroup && filteredImages.length ? (
            <ul className="picture-library-search-list" role="listbox">
              {filteredImages.slice(0, 40).map((img) => {
                const label = (img.caption || "").trim() || "Untitled picture";
                return (
                  <li key={img.id}>
                    <button
                      type="button"
                      role="option"
                      disabled={disabled}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => pickFromSearch(img)}
                      title="Insert this picture"
                    >
                      <span className="picture-library-search-preview" aria-hidden>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={img.url} alt="" />
                      </span>
                      <span className="picture-library-search-label">{label}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}
          {searchOpen && activeGroup && searchNeedle && !filteredImages.length ? (
            <p className="picture-library-search-empty muted small">No pictures match.</p>
          ) : null}
        </div>
      </div>

      {error ? <p className="bad small">{error}</p> : null}
      {loading ? <p className="muted small">Loading library…</p> : null}
      {savedHint ? <p className="ok small">{savedHint}</p> : null}

      <div className="picture-library-grid">
        {!loading && activeGroup && !activeImages.length ? (
          <p className="muted small picture-library-empty">
            No pictures in this group yet.
          </p>
        ) : null}
        {!loading && activeGroup && activeImages.length && !filteredImages.length ? (
          <p className="muted small picture-library-empty">No pictures match your search.</p>
        ) : null}
        {filteredImages.map((img) => (
          <div key={img.id} className="picture-library-tile">
            <label className="picture-library-caption-label small muted">Details</label>
            <textarea
              className="picture-library-caption"
              rows={2}
              value={img.caption || ""}
              placeholder="Add details (edit or clear anytime)"
              disabled={busy || disabled}
              onChange={(e) => setCaptionLocal(img.id, e.target.value)}
              onBlur={(e) => void commitCaption(img, e.target.value)}
            />
            <button
              type="button"
              className="picture-library-thumb"
              disabled={disabled}
              title={img.caption?.trim() || "Insert picture"}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => insertImage(img)}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={img.url} alt={img.caption || "Library picture"} loading="lazy" />
            </button>
            <div className="picture-library-tile-meta">
              <span className="muted small">{formatSize(img.size)}</span>
              <button
                type="button"
                className="linkish small"
                disabled={busy}
                onClick={() => void handleDeleteImage(img)}
              >
                Remove
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="picture-library-manage">
        <p className="small muted picture-library-manage-title">Library admin</p>
        <div className="picture-library-group-row">
          <button
            type="button"
            className="btn ghost small"
            disabled={!activeGroup || busy}
            onClick={() => void handleRenameGroup()}
            title="Rename group"
          >
            Rename
          </button>
          <button
            type="button"
            className="btn ghost small"
            disabled={!activeGroup || busy}
            onClick={() => void handleDeleteGroup()}
            title="Delete group"
          >
            Delete
          </button>
        </div>

        <div className="picture-library-new-group">
          <input
            value={newGroupName}
            onChange={(e) => setNewGroupName(e.target.value)}
            placeholder="New group name"
            disabled={busy}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void handleCreateGroup();
              }
            }}
          />
          <button
            type="button"
            className="btn small"
            disabled={busy || !newGroupName.trim()}
            onClick={() => void handleCreateGroup()}
          >
            Add group
          </button>
        </div>

        <div className="picture-library-upload">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/jpg,image/gif,image/webp"
            multiple
            hidden
            onChange={(e) => {
              void handleUpload(e.target.files);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            className="btn"
            disabled={!activeGroup || busy || disabled}
            onClick={() => fileInputRef.current?.click()}
          >
            {busy ? "Working…" : "Upload to group"}
          </button>
          <button
            type="button"
            className="btn picture-library-save"
            disabled={busy || !groups.length}
            onClick={() => void handleSave()}
            title="Publish this library to the shared server for every user and browser"
          >
            {busy ? "Saving…" : dirty ? "Save library *" : "Save library"}
          </button>
          <p className="muted small">
            Save publishes to the shared server (not just this PC). After Save, any laptop or
            incognito window will load the same pictures when logged in.
          </p>
        </div>
      </div>
    </aside>
  );
}
