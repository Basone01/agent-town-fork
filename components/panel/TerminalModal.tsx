"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Paperclip, X } from "lucide-react";
import { useStudio } from "@/lib/store";
import { gameEvents } from "@/lib/events";
import WorkspaceField from "@/components/hud/WorkspaceField";

interface AttachedFile {
  name: string;
  content: string;
}

function composeMessage(description: string, files: AttachedFile[]): string {
  const parts: string[] = [description.trim()];
  for (const f of files) {
    parts.push(`\n--- Attached: ${f.name} ---\n${f.content}`);
  }
  return parts.join("\n");
}

export default function TerminalModal() {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [files, setFiles] = useState<AttachedFile[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [targetSeatId, setTargetSeatId] = useState<string | undefined>(undefined);
  const { state, assignTask, prepareSessionForSeat } = useStudio();
  const titleRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isConnected = state.connection === "connected";
  const canSubmit = isConnected && description.trim().length > 0 && !submitting;

  const close = useCallback(() => {
    setOpen(false);
    setTargetSeatId(undefined);
    gameEvents.emit("terminal-closed");
  }, []);

  const reset = useCallback(() => {
    setTitle("");
    setDescription("");
    setWorkspace("");
    setFiles([]);
    setSubmitting(false);
  }, []);

  useEffect(() => {
    const handleOpen = async (seatId?: string) => {
      if (seatId) await prepareSessionForSeat(seatId);
      setTargetSeatId(seatId);
      reset();
      setOpen(true);
    };
    const unsubOpen = gameEvents.on("open-terminal", (seatId) => void handleOpen(seatId));
    const unsubQueue = gameEvents.on("open-terminal-queue", (seatId) => void handleOpen(seatId));
    return () => {
      unsubOpen();
      unsubQueue();
    };
  }, [prepareSessionForSeat, reset]);

  useEffect(() => {
    if (open) setTimeout(() => titleRef.current?.focus(), 50);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [open, close]);

  const handleFilesPicked = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files ?? []);
    if (picked.length === 0) return;
    const loaded = await Promise.all(
      picked.map(async (f) => ({ name: f.name, content: await f.text() })),
    );
    setFiles((prev) => {
      const existingNames = new Set(prev.map((f) => f.name));
      return [...prev, ...loaded.filter((f) => !existingNames.has(f.name))];
    });
    // Reset so the same file can be re-added after removal.
    e.target.value = "";
  };

  const removeFile = (name: string) => setFiles((prev) => prev.filter((f) => f.name !== name));

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    const message = composeMessage(description, files);
    assignTask(message, targetSeatId, undefined, workspace, title);
    reset();
    close();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  };

  const handleDescriptionKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSubmit();
    }
  };

  if (!open) return null;

  return (
    <div
      className="absolute inset-0 flex items-center justify-center"
      style={{ zIndex: 50, background: "rgba(0,0,0,0.6)", pointerEvents: "auto" }}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        className="pixel-panel"
        style={{
          width: "min(560px, 92vw)",
          padding: "20px",
          display: "flex",
          flexDirection: "column",
          gap: "12px",
        }}
      >
        {/* Header */}
        <div className="flex items-center justify-between">
          <div style={{ fontSize: "10px" }}>{">"} New Task</div>
          <button
            className="pixel-button"
            style={{ fontSize: "8px", padding: "2px 8px" }}
            onClick={close}
          >
            ESC
          </button>
        </div>

        {/* Not connected warning */}
        {!isConnected && (
          <div
            style={{
              fontSize: "8px",
              color: "var(--pixel-red)",
              padding: "6px",
              border: "2px solid var(--pixel-red)",
              borderRadius: "var(--pixel-radius-sm)",
            }}
          >
            Not connected. Use the HUD to connect first.
          </div>
        )}

        {/* Task name */}
        <div>
          <div style={{ fontSize: "8px", marginBottom: "4px", opacity: 0.6 }}>
            Task name (optional)
          </div>
          <input
            ref={titleRef}
            className="pixel-input"
            placeholder="e.g. Refactor auth module"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={!isConnected}
            style={{ width: "100%" }}
          />
        </div>

        {/* Description */}
        <div>
          <div style={{ fontSize: "8px", marginBottom: "4px", opacity: 0.6 }}>
            Description — supports markdown{" "}
            <span style={{ opacity: 0.5 }}>(Enter to submit · Shift+Enter for newline)</span>
          </div>
          <textarea
            className="pixel-input"
            placeholder={isConnected ? "Describe the task…" : "Connect first…"}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onKeyDown={handleDescriptionKeyDown}
            disabled={!isConnected}
            style={{ minHeight: "80px", resize: "vertical" }}
          />
        </div>

        {/* Workspace */}
        <div>
          <div style={{ fontSize: "8px", marginBottom: "4px", opacity: 0.6 }}>
            Workspace directory
          </div>
          <WorkspaceField
            value={workspace}
            onChange={setWorkspace}
            disabled={!isConnected}
            onKeyDown={handleKeyDown}
          />
        </div>

        {/* File attachments */}
        <div>
          <div
            style={{
              fontSize: "8px",
              marginBottom: "6px",
              display: "flex",
              alignItems: "center",
              gap: "8px",
            }}
          >
            <span style={{ opacity: 0.6 }}>Attached files</span>
            <button
              type="button"
              className="pixel-button"
              style={{
                fontSize: "8px",
                padding: "2px 8px",
                display: "flex",
                alignItems: "center",
                gap: "4px",
              }}
              onClick={() => fileInputRef.current?.click()}
              disabled={!isConnected}
            >
              <Paperclip size={10} />
              Add files
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              style={{ display: "none" }}
              onChange={handleFilesPicked}
            />
          </div>

          {files.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
              {files.map((f) => (
                <div
                  key={f.name}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "4px",
                    padding: "2px 6px",
                    border: "2px solid var(--pixel-border)",
                    borderRadius: "var(--pixel-radius-sm)",
                    fontSize: "8px",
                  }}
                >
                  <span
                    style={{
                      maxWidth: "160px",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {f.name}
                  </span>
                  <button
                    type="button"
                    onClick={() => removeFile(f.name)}
                    style={{
                      background: "none",
                      border: "none",
                      cursor: "pointer",
                      padding: 0,
                      display: "flex",
                    }}
                  >
                    <X size={10} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Submit */}
        <button
          className="pixel-button pixel-button--primary w-full"
          onClick={() => void handleSubmit()}
          disabled={!canSubmit}
        >
          Assign Task
        </button>
      </div>
    </div>
  );
}
