"use client";

import "./task-view.css";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { TaskItem, TaskStatus } from "@/types/game";
import { useStudio } from "@/lib/store";
import { gameEvents } from "@/lib/events";
import { formatRelativeTime } from "@/lib/constants";
import Markdown from "./Markdown";

type StatusFilter = "all" | "running" | "done" | "failed" | "stopped";

/** Maps every task status onto one of the filter buckets. */
const STATUS_BUCKET: Record<TaskStatus, Exclude<StatusFilter, "all">> = {
  submitted: "running",
  queued: "running",
  returning: "running",
  running: "running",
  completed: "done",
  failed: "failed",
  interrupted: "failed",
  stopped: "stopped",
};

const FILTERS: { id: StatusFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "running", label: "Running" },
  { id: "done", label: "Done" },
  { id: "failed", label: "Failed" },
  { id: "stopped", label: "Stopped" },
];

function statusLabel(status: TaskStatus): string {
  if (status === "submitted") return "sending";
  if (status === "completed") return "done";
  return status;
}

export default function TaskViewModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { state } = useStudio();
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<StatusFilter>("all");
  // Tracks which task's result was just copied — keyed by id so switching
  // tasks naturally clears the "Copied!" flash without an effect.
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // All tasks, newest first.
  const allTasks = useMemo(
    () => [...state.tasks].sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "")),
    [state.tasks],
  );

  // Search + status filter combine with AND.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return allTasks.filter((task) => {
      if (filter !== "all" && STATUS_BUCKET[task.status] !== filter) return false;
      if (q) {
        const haystack =
          `${task.message} ${task.result ?? ""} ${task.actorName ?? ""}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [allTasks, search, filter]);

  // Selected task, falling back to the first visible row.
  const selected: TaskItem | undefined = useMemo(
    () => filtered.find((t) => t.taskId === selectedId) ?? filtered[0],
    [filtered, selectedId],
  );

  const sessionLabel = useCallback(
    (key: string) => state.sessions.find((s) => s.key === key)?.label ?? `Session ${key.slice(-6)}`,
    [state.sessions],
  );

  // Escape closes (capture phase so it fires even from the search input).
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [open, onClose]);

  if (!open) return null;

  const handleCopy = () => {
    if (!selected?.result) return;
    const id = selected.taskId;
    navigator.clipboard
      .writeText(selected.result)
      .then(() => {
        setCopiedId(id);
        setTimeout(() => setCopiedId((c) => (c === id ? null : c)), 1500);
      })
      .catch(() => {
        /* clipboard unavailable — ignore */
      });
  };

  const handleStop = () => {
    if (!selected) return;
    gameEvents.emit("stop-task", selected.runId ?? selected.taskId, selected.seatId ?? "");
  };

  const isRunning = selected ? STATUS_BUCKET[selected.status] === "running" : false;

  return (
    <div
      className="task-view-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Task View"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="task-view-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="task-view-header">
          <div className="task-view-title">{">"} Task View</div>
          <input
            className="pixel-input task-view-search"
            placeholder="Search tasks..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
          />
          <div className="task-view-chips">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                className={`task-view-chip ${filter === f.id ? "is-active" : ""}`}
                onClick={() => setFilter(f.id)}
              >
                {f.label}
              </button>
            ))}
          </div>
          <div className="task-view-spacer" />
          <button type="button" className="pixel-button task-view-esc" onClick={onClose}>
            ESC
          </button>
        </div>

        {/* Body */}
        <div className="task-view-body">
          {/* Task list */}
          <div className="task-view-list">
            {filtered.length === 0 ? (
              <div className="task-view-empty">
                {allTasks.length === 0 ? "No tasks yet." : "No tasks match."}
              </div>
            ) : (
              filtered.map((task) => (
                <button
                  key={task.taskId}
                  type="button"
                  className={`task-view-row ${
                    selected?.taskId === task.taskId ? "is-selected" : ""
                  }`}
                  onClick={() => setSelectedId(task.taskId)}
                >
                  <div className="task-view-row__top">
                    <span className={`hud-status hud-status--${task.status}`}>
                      {statusLabel(task.status)}
                    </span>
                    <span className="task-view-row__time">
                      {formatRelativeTime(task.completedAt ?? task.createdAt)}
                    </span>
                  </div>
                  <div className="task-view-row__title">{task.message}</div>
                  <div className="task-view-row__sub">
                    {task.actorName ?? "Unassigned"} · {sessionLabel(task.sessionKey)}
                  </div>
                </button>
              ))
            )}
          </div>

          {/* Detail pane */}
          <div className="task-view-detail">
            {!selected ? (
              <div className="task-view-empty">Select a task to view its detail.</div>
            ) : (
              <>
                <div className="task-view-detail__meta">
                  <span className={`hud-status hud-status--${selected.status}`}>
                    {statusLabel(selected.status)}
                  </span>
                  <span>{selected.actorName ?? "Unassigned"}</span>
                  <span>{sessionLabel(selected.sessionKey)}</span>
                  <span>created {formatRelativeTime(selected.createdAt)}</span>
                  {selected.completedAt && (
                    <span>finished {formatRelativeTime(selected.completedAt)}</span>
                  )}
                </div>

                <div className="task-view-section-label">Prompt</div>
                <div className="task-view-prompt">{selected.message}</div>

                <div className="task-view-section-label">Result</div>
                {selected.result ? (
                  <Markdown>{selected.result}</Markdown>
                ) : (
                  <div className="task-view-placeholder">
                    {isRunning
                      ? "Task is still running — no result yet."
                      : `No result (${statusLabel(selected.status)}).`}
                  </div>
                )}

                <div className="task-view-actions">
                  <button
                    type="button"
                    className="pixel-button"
                    disabled={!selected.result}
                    onClick={handleCopy}
                  >
                    {copiedId === selected.taskId ? "Copied!" : "Copy result"}
                  </button>
                  {isRunning && (
                    <button type="button" className="pixel-button" onClick={handleStop}>
                      Stop task
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
