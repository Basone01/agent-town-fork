"use client";

import "./directory-browser.css";

import { useCallback, useEffect, useState } from "react";
import { Folder, ArrowUp, House, Check } from "lucide-react";
import { createLogger } from "@/lib/logger";

const log = createLogger("DirectoryBrowser");

interface Entry {
  name: string;
  path: string;
}

interface Listing {
  path: string;
  parent: string | null;
  entries: Entry[];
}

interface DirectoryBrowserModalProps {
  open: boolean;
  /** Directory the browser opens at — blank falls back to the server home dir. */
  initialPath?: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}

/**
 * In-app filesystem browser. Unlike the native OS folder dialog, this runs
 * entirely in the page and fetches listings over HTTP, so it works when
 * Agent Town is opened from a browser on another computer. It walks the
 * server's directory tree via GET /api/fs.
 */
export default function DirectoryBrowserModal({
  open,
  initialPath,
  onSelect,
  onClose,
}: DirectoryBrowserModalProps) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [pathInput, setPathInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch a directory listing, syncing the path input and clearing stale errors.
  const load = useCallback(async (dir?: string) => {
    setLoading(true);
    setError(null);
    try {
      const qs = dir ? `?path=${encodeURIComponent(dir)}` : "";
      const res = await fetch(`/api/fs${qs}`);
      const data = (await res.json()) as Partial<Listing> & { error?: string };
      if (!res.ok || !data.path) {
        setError(data.error ?? `Request failed (${res.status})`);
        return;
      }
      setListing(data as Listing);
      setPathInput(data.path);
    } catch (err) {
      log.warn("listing failed:", err);
      setError("Could not reach the server.");
    } finally {
      setLoading(false);
    }
  }, []);

  // (Re)load each time the modal opens, starting from the field's current value.
  useEffect(() => {
    if (open) load(initialPath?.trim() || undefined);
  }, [open, initialPath, load]);

  // Escape closes — capture phase so it fires from the path input too, and
  // stopPropagation keeps it from also closing the modal underneath.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [open, onClose]);

  if (!open) return null;

  const currentPath = listing?.path ?? "";

  return (
    <div
      className="dir-browser-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Choose a directory"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="dir-browser" onClick={(e) => e.stopPropagation()}>
        <div className="dir-browser__header">
          <div className="dir-browser__title">{">"} Choose a directory</div>
          <button type="button" className="pixel-button dir-browser__esc" onClick={onClose}>
            ESC
          </button>
        </div>

        {/* Path bar — type a path directly, or use the up / home shortcuts. */}
        <div className="dir-browser__pathbar">
          <button
            type="button"
            className="pixel-button dir-browser__icon-btn"
            onClick={() => listing?.parent && load(listing.parent)}
            disabled={!listing?.parent || loading}
            title="Up one level"
          >
            <ArrowUp size={13} />
          </button>
          <button
            type="button"
            className="pixel-button dir-browser__icon-btn"
            onClick={() => load()}
            disabled={loading}
            title="Home directory"
          >
            <House size={13} />
          </button>
          <input
            className="pixel-input dir-browser__path-input"
            value={pathInput}
            placeholder="Type a path and press Enter…"
            onChange={(e) => setPathInput(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") {
                e.preventDefault();
                load(pathInput.trim());
              }
            }}
          />
        </div>

        {/* Sub-folder list — clicking a row descends into it. */}
        <div className="dir-browser__list">
          {loading ? (
            <div className="dir-browser__note">Loading…</div>
          ) : error ? (
            <div className="dir-browser__note dir-browser__note--error">{error}</div>
          ) : listing && listing.entries.length === 0 ? (
            <div className="dir-browser__note">No sub-folders here.</div>
          ) : (
            listing?.entries.map((entry) => (
              <button
                key={entry.path}
                type="button"
                className="dir-browser__row"
                onClick={() => load(entry.path)}
              >
                <Folder size={13} className="dir-browser__row-icon" />
                <span className="dir-browser__row-name">{entry.name}</span>
              </button>
            ))
          )}
        </div>

        {/* Footer — the current directory plus the confirm action. */}
        <div className="dir-browser__footer">
          <div className="dir-browser__current" title={currentPath}>
            {currentPath || "—"}
          </div>
          <button type="button" className="pixel-button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="pixel-button pixel-button--primary dir-browser__use"
            onClick={() => currentPath && onSelect(currentPath)}
            disabled={!currentPath || loading}
          >
            <Check size={12} /> Use this folder
          </button>
        </div>
      </div>
    </div>
  );
}
