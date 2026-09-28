"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createPictureGroup,
  deletePictureFromGroup,
  deletePictureGroup,
  fetchPictureLibrary,
  renamePictureGroup,
  uploadPictureToGroup,
  type PictureLibraryGroup,
  type PictureLibraryImage,
} from "@/lib/pictureLibrary";
import {
  fileToDataUrl,
  loadLocalPictureLibrary,
  mergePictureLibraries,
  saveLocalPictureLibrary,
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

function newLocalId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
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
  const fileInputRef = useRef<HTMLInputElement>(null);

  const persistLocal = useCallback((nextGroups: PictureLibraryGroup[]) => {
    saveLocalPictureLibrary({ groups: nextGroups });
    setDirty(false);
    setSavedHint("Saved — pictures stay until you remove them.");
    window.setTimeout(() => setSavedHint(null), 4000);
  }, []);

  const refresh = useCallback(async () => {
    setError(null);
    const local = loadLocalPictureLibrary();
    try {
      const remote = await fetchPictureLibrary();
      const merged = mergePictureLibraries(local, remote);
      setGroups(merged.groups);
      setActiveGroupId((prev) => {
        if (prev && merged.groups.some((g) => g.id === prev)) return prev;
        return merged.groups[0]?.id || "";
      });
      // Keep browser copy in sync so redeploys cannot wipe the library UI.
      if (merged.groups.length) {
        saveLocalPictureLibrary(merged);
      }
    } catch (e) {
      setGroups(local.groups);
      setActiveGroupId((prev) => {
        if (prev && local.groups.some((g) => g.id === prev)) return prev;
        return local.groups[0]?.id || "";
      });
      if (!local.groups.length) {
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

  async function handleCreateGroup() {
    const name = newGroupName.trim();
    if (!name || busy) return;
    setBusy(true);
    setError(null);
    try {
      let row: PictureLibraryGroup;
      try {
        row = await createPictureGroup(name);
      } catch {
        row = {
          id: newLocalId("group"),
          name,
          created_at: new Date().toISOString(),
          images: [],
        };
      }
      const next = [...groups.filter((g) => g.id !== row.id), row];
      setGroups(next);
      setActiveGroupId(row.id);
      setNewGroupName("");
      setDirty(true);
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
      try {
        await renamePictureGroup(activeGroup.id, name);
      } catch {
        /* local rename still applies */
      }
      const next = groups.map((g) => (g.id === activeGroup.id ? { ...g, name } : g));
      setGroups(next);
      setDirty(true);
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
      try {
        await deletePictureGroup(activeGroup.id);
      } catch {
        /* still remove locally */
      }
      const next = groups.filter((g) => g.id !== activeGroup.id);
      setGroups(next);
      setActiveGroupId(next[0]?.id || "");
      persistLocal(next);
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
      for (const file of Array.from(files)) {
        if (!file.type.startsWith("image/")) continue;
        try {
          const img = await uploadPictureToGroup(activeGroup.id, file);
          added.push(img);
        } catch {
          // API/ephemeral disk failed — keep a durable data-URL copy in the browser.
          const url = await fileToDataUrl(file);
          added.push({
            id: newLocalId("img"),
            url,
            filename: file.name || "image.png",
            content_type: file.type || "image/png",
            size: file.size,
            created_at: new Date().toISOString(),
          });
        }
      }
      if (!added.length) {
        setError("No images uploaded");
        return;
      }
      const next = groups.map((g) => {
        if (g.id !== activeGroup.id) return g;
        const byId = new Map((g.images || []).map((i) => [i.id, i]));
        for (const img of added) byId.set(img.id, img);
        return { ...g, images: Array.from(byId.values()) };
      });
      setGroups(next);
      setDirty(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteImage(img: PictureLibraryImage) {
    if (!activeGroup || busy) return;
    if (!window.confirm(`Remove “${img.filename}” from this group?`)) return;
    setBusy(true);
    setError(null);
    try {
      try {
        await deletePictureFromGroup(activeGroup.id, img.id);
      } catch {
        /* local delete still applies */
      }
      const next = groups.map((g) =>
        g.id === activeGroup.id
          ? { ...g, images: (g.images || []).filter((i) => i.id !== img.id) }
          : g,
      );
      setGroups(next);
      persistLocal(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not remove picture");
    } finally {
      setBusy(false);
    }
  }

  function handleSave() {
    if (busy) return;
    persistLocal(groups);
  }

  function insertImage(img: PictureLibraryImage) {
    if (disabled) return;
    onInsert(img.url, img.filename || "image");
  }

  return (
    <aside className={`picture-library ${className}`.trim()} aria-label="Picture library">
      <div className="picture-library-head">
        <h3>Picture library</h3>
        <p className="muted small">
          Shared for all users. Click a picture to paste it where the cursor was in the email.
          Press <strong>Save</strong> after uploading so pictures stay until you delete them.
        </p>
      </div>

      <div className="picture-library-groups">
        <label className="small muted">Groups</label>
        <div className="picture-library-group-row">
          <select
            value={activeGroupId}
            disabled={loading || !groups.length}
            onChange={(e) => setActiveGroupId(e.target.value)}
          >
            {!groups.length ? <option value="">No groups yet</option> : null}
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name} ({g.images?.length || 0})
              </option>
            ))}
          </select>
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
          disabled={busy || (!dirty && !groups.length)}
          onClick={handleSave}
          title="Keep pictures in this browser until you delete them"
        >
          {dirty ? "Save library" : "Save"}
        </button>
        <p className="muted small">
          Upload, then click Save. Saved pictures remain here until you remove them.
        </p>
        {savedHint ? <p className="ok small">{savedHint}</p> : null}
      </div>

      {error ? <p className="bad small">{error}</p> : null}
      {loading ? <p className="muted small">Loading library…</p> : null}

      <div className="picture-library-grid">
        {!loading && activeGroup && !(activeGroup.images || []).length ? (
          <p className="muted small picture-library-empty">
            No pictures in this group yet. Upload above, then Save.
          </p>
        ) : null}
        {(activeGroup?.images || []).map((img) => (
          <div key={img.id} className="picture-library-tile">
            <button
              type="button"
              className="picture-library-thumb"
              disabled={disabled}
              title={`Insert ${img.filename}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => insertImage(img)}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={img.url} alt={img.filename} loading="lazy" />
            </button>
            <div className="picture-library-tile-meta">
              <span className="picture-library-name" title={img.filename}>
                {img.filename}
              </span>
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
    </aside>
  );
}
