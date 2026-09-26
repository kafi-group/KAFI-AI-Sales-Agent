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

export function PictureLibraryPanel({
  onInsert,
  disabled = false,
  className = "",
}: PictureLibraryPanelProps) {
  const [groups, setGroups] = useState<PictureLibraryGroup[]>([]);
  const [activeGroupId, setActiveGroupId] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newGroupName, setNewGroupName] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const data = await fetchPictureLibrary();
      const next = data.groups || [];
      setGroups(next);
      setActiveGroupId((prev) => {
        if (prev && next.some((g) => g.id === prev)) return prev;
        return next[0]?.id || "";
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load picture library");
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
      const row = await createPictureGroup(name);
      setNewGroupName("");
      await refresh();
      setActiveGroupId(row.id);
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
      await refresh();
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
      await refresh();
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
      for (const file of Array.from(files)) {
        if (!file.type.startsWith("image/")) continue;
        await uploadPictureToGroup(activeGroup.id, file);
      }
      await refresh();
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
      await deletePictureFromGroup(activeGroup.id, img.id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not remove picture");
    } finally {
      setBusy(false);
    }
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
        <p className="muted small">
          Uploads stay in the library so anyone can insert them — no need for the file on their PC.
        </p>
      </div>

      {error ? <p className="bad small">{error}</p> : null}
      {loading ? <p className="muted small">Loading library…</p> : null}

      <div className="picture-library-grid">
        {!loading && activeGroup && !(activeGroup.images || []).length ? (
          <p className="muted small picture-library-empty">
            No pictures in this group yet. Upload above.
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
