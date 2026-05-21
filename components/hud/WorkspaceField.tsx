"use client";

import "./workspace-field.css";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Folder, Star, Plus, X } from "lucide-react";
import { loadFavoriteWorkspaces, saveFavoriteWorkspaces } from "@/lib/persistence";
import DirectoryBrowserModal from "./DirectoryBrowserModal";

interface WorkspaceFieldProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  /** Forwarded to the path input (after the field stops key propagation). */
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
}

/**
 * The server's default workspace dir, fetched once and shared across every
 * field instance — the value is process-stable, so one request is enough.
 */
let defaultDirPromise: Promise<string | null> | null = null;
function fetchDefaultDir(): Promise<string | null> {
  defaultDirPromise ??= fetch("/api/workspace")
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => (typeof data?.dir === "string" ? data.dir : null))
    .catch(() => null);
  return defaultDirPromise;
}

/** Workspace directory input with an in-app folder browser and a favorites list. */
export default function WorkspaceField({
  value,
  onChange,
  disabled,
  onKeyDown,
}: WorkspaceFieldProps) {
  const [browserOpen, setBrowserOpen] = useState(false);
  const [favorites, setFavorites] = useState<string[]>(() => loadFavoriteWorkspaces());
  const [favOpen, setFavOpen] = useState(false);
  const [defaultDir, setDefaultDir] = useState<string | null>(null);
  const favRef = useRef<HTMLDivElement>(null);

  // Learn the server's default workspace dir so a blank field can still show
  // where the agent will actually run.
  useEffect(() => {
    let alive = true;
    fetchDefaultDir().then((dir) => {
      if (alive) setDefaultDir(dir);
    });
    return () => {
      alive = false;
    };
  }, []);

  // Close the favorites popover on an outside click.
  useEffect(() => {
    if (!favOpen) return;
    const onDown = (e: MouseEvent) => {
      if (favRef.current && !favRef.current.contains(e.target as Node)) setFavOpen(false);
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [favOpen]);

  const trimmed = value.trim();
  const alreadySaved = trimmed.length > 0 && favorites.includes(trimmed);

  const commitFavorites = (next: string[]) => {
    setFavorites(next);
    saveFavoriteWorkspaces(next);
  };

  const addFavorite = () => {
    if (!trimmed || favorites.includes(trimmed)) return;
    commitFavorites([trimmed, ...favorites]);
  };

  const selectFavorite = (dir: string) => {
    onChange(dir);
    setFavOpen(false);
  };

  return (
    <div className="workspace-field-block">
      <div className="workspace-field">
        <Folder size={13} className="workspace-field__icon" />
        <input
          className="pixel-input workspace-field__input"
          placeholder="Workspace dir — blank uses the server default"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            onKeyDown?.(e);
          }}
          disabled={disabled}
        />
        <button
          type="button"
          className="pixel-button workspace-field__btn"
          onClick={() => setBrowserOpen(true)}
          disabled={disabled}
          title="Browse for a folder"
        >
          Browse…
        </button>
        <div className="workspace-field__fav" ref={favRef}>
          <button
            type="button"
            className={`pixel-button workspace-field__star ${favOpen ? "is-open" : ""}`}
            onClick={() => setFavOpen((o) => !o)}
            disabled={disabled}
            title="Favorite directories"
          >
            <Star size={12} />
          </button>
          {favOpen && (
            <div className="workspace-field__popover">
              <div className="workspace-field__popover-head">Favorites</div>
              <button
                type="button"
                className="workspace-field__add"
                onClick={addFavorite}
                disabled={!trimmed || alreadySaved}
              >
                <Plus size={11} />
                {alreadySaved
                  ? "Already saved"
                  : trimmed
                    ? "Save current directory"
                    : "Type a path to save"}
              </button>
              {favorites.length === 0 ? (
                <div className="workspace-field__empty">No favorites yet.</div>
              ) : (
                <div className="workspace-field__list">
                  {favorites.map((dir) => (
                    <div key={dir} className="workspace-field__item">
                      <button
                        type="button"
                        className="workspace-field__item-path"
                        onClick={() => selectFavorite(dir)}
                        title={dir}
                      >
                        {dir}
                      </button>
                      <button
                        type="button"
                        className="workspace-field__item-remove"
                        onClick={() => commitFavorites(favorites.filter((f) => f !== dir))}
                        title="Remove from favorites"
                      >
                        <X size={11} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      {!trimmed && defaultDir && (
        <div className="workspace-field__hint" title={defaultDir}>
          Using server default: <span className="workspace-field__hint-path">{defaultDir}</span>
        </div>
      )}
      <DirectoryBrowserModal
        open={browserOpen}
        initialPath={value || defaultDir || ""}
        onSelect={(dir) => {
          onChange(dir);
          setBrowserOpen(false);
        }}
        onClose={() => setBrowserOpen(false)}
      />
    </div>
  );
}
