"use client";

import "./task-view.css";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SendHorizontal } from "lucide-react";
import type { TaskItem, TaskStatus } from "@/types/game";
import { useStudio } from "@/lib/store";
import { gameEvents } from "@/lib/events";
import { formatRelativeTime, isVisibleChatMessage } from "@/lib/constants";
import Markdown from "./Markdown";
import MessageBubble from "./MessageBubble";
import WorkspaceField from "./WorkspaceField";

type StatusFilter = "all" | "draft" | "running" | "done" | "failed" | "stopped";
type DetailTab = "result" | "conversation";

/** Maps every task status onto one of the filter buckets. */
const STATUS_BUCKET: Record<TaskStatus, Exclude<StatusFilter, "all">> = {
  draft: "draft",
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
  { id: "draft", label: "Drafts" },
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

/** One representative status for a session group — surfaces the most
 *  actionable state first (running > failed > draft > stopped > done). */
function combineSessionStatus(tasks: TaskItem[]): TaskStatus {
  const buckets = new Set(tasks.map((t) => STATUS_BUCKET[t.status]));
  if (buckets.has("running")) return "running";
  if (buckets.has("failed")) return "failed";
  if (buckets.has("draft")) return "draft";
  if (buckets.has("stopped")) return "stopped";
  return "completed";
}

/** A set of tasks that all share one sessionKey. */
interface TaskGroup {
  sessionKey: string;
  /** Newest first — mirrors the `filtered` ordering it is built from. */
  tasks: TaskItem[];
  latest: TaskItem;
  combinedStatus: TaskStatus;
  runningCount: number;
}

/** One task row in the list — rendered standalone or as a group child. */
function TaskRow({
  task,
  isSelected,
  isChild = false,
  showSession = false,
  sessionLabel,
  onSelect,
}: {
  task: TaskItem;
  isSelected: boolean;
  isChild?: boolean;
  showSession?: boolean;
  sessionLabel: (key: string) => string;
  onSelect: (taskId: string) => void;
}) {
  return (
    <button
      type="button"
      className={`task-view-row ${isChild ? "task-view-row--child" : ""} ${
        isSelected ? "is-selected" : ""
      }`}
      onClick={() => onSelect(task.taskId)}
    >
      <div className="task-view-row__top">
        <span className={`hud-status hud-status--${task.status}`}>{statusLabel(task.status)}</span>
        <span className="task-view-row__time">
          {formatRelativeTime(task.completedAt ?? task.createdAt)}
        </span>
      </div>
      <div className="task-view-row__title">{task.title ?? task.message}</div>
      <div className="task-view-row__sub">
        {task.actorName ?? "Unassigned"}
        {showSession ? ` · ${sessionLabel(task.sessionKey)}` : ""}
      </div>
    </button>
  );
}

export default function TaskViewModal({
  open,
  onClose,
  initialTaskId,
}: {
  open: boolean;
  onClose: () => void;
  initialTaskId?: string;
}) {
  const { state, assignTask, assignDraft, deleteTask } = useStudio();
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<StatusFilter>("all");
  // Session groups currently expanded in the list. Default collapsed: a
  // multi-task session shows as one summary row until the user opens it.
  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(() => new Set());
  const [tab, setTab] = useState<DetailTab>("result");
  const [draft, setDraft] = useState("");
  // Working directory for the next follow-up — follows the selected task.
  const [workspaceDraft, setWorkspaceDraft] = useState("");
  // Tracks which task's result was just copied — keyed by id so switching
  // tasks naturally clears the "Copied!" flash without an effect.
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);

  const isConnected = state.connection === "connected";

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
          `${task.title ?? ""} ${task.message} ${task.result ?? ""} ${task.actorName ?? ""}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [allTasks, search, filter]);

  // Tasks grouped by session — follow-ups on the same session collapse into a
  // single expandable row. Map insertion order preserves the newest-first
  // ordering of `filtered`, so groups themselves sort by recency.
  const groups = useMemo<TaskGroup[]>(() => {
    const bySession = new Map<string, TaskItem[]>();
    for (const task of filtered) {
      const bucket = bySession.get(task.sessionKey);
      if (bucket) bucket.push(task);
      else bySession.set(task.sessionKey, [task]);
    }
    return [...bySession.values()].map((tasks) => ({
      sessionKey: tasks[0].sessionKey,
      tasks,
      latest: tasks[0],
      combinedStatus: combineSessionStatus(tasks),
      runningCount: tasks.filter((t) => STATUS_BUCKET[t.status] === "running").length,
    }));
  }, [filtered]);

  // Selected task, falling back to the first visible row.
  const selected: TaskItem | undefined = useMemo(
    () => filtered.find((t) => t.taskId === selectedId) ?? filtered[0],
    [filtered, selectedId],
  );

  // Expand/collapse a session group. Opening a group whose tasks aren't the
  // current selection also moves selection to that session's latest task, so
  // the detail pane reflects what the user just opened.
  const toggleGroup = useCallback((group: TaskGroup) => {
    setExpandedSessions((prev) => {
      const next = new Set(prev);
      if (next.has(group.sessionKey)) next.delete(group.sessionKey);
      else next.add(group.sessionKey);
      return next;
    });
    setSelectedId((current) =>
      group.tasks.some((t) => t.taskId === current) ? current : group.latest.taskId,
    );
  }, []);

  const sessionLabel = useCallback(
    (key: string) => state.sessions.find((s) => s.key === key)?.label ?? `Session ${key.slice(-6)}`,
    [state.sessions],
  );

  // The full conversation thread for the selected task's session.
  const conversation = useMemo(() => {
    if (!selected) return [];
    return state.chatMessages.filter(
      (m) => m.sessionKey === selected.sessionKey && isVisibleChatMessage(m),
    );
  }, [selected, state.chatMessages]);

  // Actor fallback for assistant bubbles, mirrored from ChatPanel.
  const actorByRunId = useMemo(() => {
    const map = new Map<string, string>();
    for (const task of state.tasks) {
      if (!task.actorName) continue;
      if (task.runId) map.set(task.runId, task.actorName);
      map.set(task.taskId, task.actorName);
    }
    return map;
  }, [state.tasks]);

  // Session that owns the task the modal opened on. Derived as a stable string
  // so the auto-expand effect below fires once per open — not on every task
  // update — which would otherwise re-expand a group the user just collapsed.
  const initialSessionKey = useMemo(
    () =>
      initialTaskId ? state.tasks.find((t) => t.taskId === initialTaskId)?.sessionKey : undefined,
    [initialTaskId, state.tasks],
  );

  // Opened on a specific task (clicked from the flyout): select it and clear
  // the filter/search so a stale filter can't hide the row the user picked.
  useEffect(() => {
    if (!open || !initialTaskId) return;
    /* eslint-disable react-hooks/set-state-in-effect -- syncing selection to the task that opened the modal */
    setSelectedId(initialTaskId);
    setSearch("");
    setFilter("all");
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [open, initialTaskId]);

  // Reveal the group that owns the task the modal opened on, so its row isn't
  // hidden inside a collapsed session. Keyed on `initialSessionKey` (a stable
  // string), so collapsing the group by hand sticks across task updates.
  useEffect(() => {
    if (!open || !initialSessionKey) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reveal the opened task's group
    setExpandedSessions((prev) =>
      prev.has(initialSessionKey) ? prev : new Set(prev).add(initialSessionKey),
    );
  }, [open, initialSessionKey]);

  // The workspace field follows the selected task — pre-filled with the dir
  // that task ran in, so a follow-up stays put unless the user changes it.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sync field to the selected task
    setWorkspaceDraft(selected?.workspace ?? "");
  }, [selected?.taskId, selected?.workspace]);

  // Escape closes (capture phase so it fires even from the inputs).
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

  // Keep the conversation pinned to the latest message while it streams.
  useEffect(() => {
    if (tab === "conversation" && threadRef.current) {
      threadRef.current.scrollTop = threadRef.current.scrollHeight;
    }
  }, [tab, conversation.length]);

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

  const handleContinue = () => {
    const text = draft.trim();
    if (!text || !selected || !isConnected) return;
    // Targets the task's own session — the bridge resumes it via --resume.
    assignTask(text, selected.seatId, selected.sessionKey, workspaceDraft);
    setDraft("");
    setTab("conversation");
  };

  const handleContinueKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    e.stopPropagation();
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleContinue();
    }
  };

  const isRunning = selected ? STATUS_BUCKET[selected.status] === "running" : false;
  const isDraft = selected?.status === "draft";

  // Promote the selected draft as-is. Editing happens in the draft form.
  const handleAssignDraft = () => {
    if (!selected || !isDraft || !isConnected) return;
    assignDraft(selected.taskId);
  };

  // Hand the draft off to the task form for editing; close so it isn't hidden
  // behind this modal.
  const handleEditDraft = () => {
    if (!selected || !isDraft) return;
    gameEvents.emit("edit-draft", selected.taskId);
    onClose();
  };

  const handleDelete = () => {
    if (!selected) return;
    // Selection auto-recovers: `selected` falls back to the first visible row.
    deleteTask(selected.taskId);
  };

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
              groups.map((group) => {
                // Lone-task sessions render as a plain row — no group chrome.
                if (group.tasks.length === 1) {
                  const task = group.tasks[0];
                  return (
                    <TaskRow
                      key={task.taskId}
                      task={task}
                      isSelected={selected?.taskId === task.taskId}
                      showSession
                      sessionLabel={sessionLabel}
                      onSelect={setSelectedId}
                    />
                  );
                }
                const expanded = expandedSessions.has(group.sessionKey);
                const hasSelected = group.tasks.some((t) => t.taskId === selected?.taskId);
                return (
                  <div key={group.sessionKey} className="task-view-group">
                    <button
                      type="button"
                      className={`task-view-group__header ${hasSelected ? "is-active" : ""}`}
                      onClick={() => toggleGroup(group)}
                      aria-expanded={expanded}
                    >
                      <div className="task-view-row__top">
                        <span className="task-view-group__label">
                          <span className="task-view-group__chevron">{expanded ? "▾" : "▸"}</span>
                          <span className={`hud-status hud-status--${group.combinedStatus}`}>
                            {statusLabel(group.combinedStatus)}
                          </span>
                        </span>
                        <span className="task-view-row__time">
                          {formatRelativeTime(group.latest.completedAt ?? group.latest.createdAt)}
                        </span>
                      </div>
                      <div className="task-view-row__title">
                        {group.latest.title ?? group.latest.message}
                      </div>
                      <div className="task-view-row__sub">
                        {group.tasks.length} tasks · {sessionLabel(group.sessionKey)}
                        {group.runningCount > 0 ? ` · ${group.runningCount} running` : ""}
                      </div>
                    </button>
                    {expanded && (
                      <div className="task-view-group__children">
                        {group.tasks.map((task) => (
                          <TaskRow
                            key={task.taskId}
                            task={task}
                            isSelected={selected?.taskId === task.taskId}
                            isChild
                            sessionLabel={sessionLabel}
                            onSelect={setSelectedId}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>

          {/* Detail pane */}
          <div className="task-view-detail">
            {!selected ? (
              <div className="task-view-empty">Select a task to view its detail.</div>
            ) : (
              <>
                {selected.title && (
                  <div className="task-view-detail__heading">{selected.title}</div>
                )}

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
                  <button type="button" className="task-view-delete" onClick={handleDelete}>
                    Delete
                  </button>
                </div>

                {!isDraft && (
                  <div className="task-view-tabs">
                    <button
                      type="button"
                      className={`task-view-tab ${tab === "result" ? "is-active" : ""}`}
                      onClick={() => setTab("result")}
                    >
                      Result
                    </button>
                    <button
                      type="button"
                      className={`task-view-tab ${tab === "conversation" ? "is-active" : ""}`}
                      onClick={() => setTab("conversation")}
                    >
                      Conversation
                    </button>
                  </div>
                )}

                <div className="task-view-tabcontent" ref={threadRef}>
                  {isDraft ? (
                    <>
                      <div className="task-view-section-label">Prompt</div>
                      <div className="task-view-prompt">{selected.message}</div>
                      <div className="task-view-placeholder" style={{ marginTop: "12px" }}>
                        Draft — not yet assigned. Edit it or assign it to a worker below.
                      </div>
                    </>
                  ) : tab === "result" ? (
                    <>
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
                      </div>
                    </>
                  ) : conversation.length === 0 ? (
                    <div className="task-view-placeholder">
                      {isRunning
                        ? "Waiting for messages..."
                        : "No conversation recorded for this session."}
                    </div>
                  ) : (
                    <div className="task-view-thread">
                      {conversation.map((m) => (
                        <MessageBubble
                          key={m.id}
                          msg={m}
                          actorName={actorByRunId.get(m.runId)}
                          renderMarkdown
                        />
                      ))}
                    </div>
                  )}
                </div>

                {isDraft ? (
                  /* Draft footer: edit in the task form, or assign as-is */
                  <div className="task-view-continue">
                    <button type="button" className="pixel-button" onClick={handleEditDraft}>
                      Edit Draft
                    </button>
                    <div className="task-view-spacer" />
                    <button
                      type="button"
                      className="pixel-button pixel-button--primary"
                      onClick={handleAssignDraft}
                      disabled={!isConnected}
                      title={isConnected ? "Assign this draft to a worker" : "Connect first"}
                    >
                      Assign Task
                    </button>
                  </div>
                ) : (
                  <>
                    {/* Working directory for the follow-up */}
                    <div className="task-view-workspace">
                      <WorkspaceField
                        value={workspaceDraft}
                        onChange={setWorkspaceDraft}
                        disabled={!isConnected}
                      />
                    </div>

                    {/* Persistent continue-conversation row */}
                    <div className="task-view-continue">
                      <textarea
                        className="pixel-input task-view-continue__input"
                        placeholder={
                          isConnected ? "Continue the conversation..." : "Connect first..."
                        }
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={handleContinueKeyDown}
                        disabled={!isConnected}
                      />
                      {isRunning && (
                        <button type="button" className="pixel-button" onClick={handleStop}>
                          Stop
                        </button>
                      )}
                      <button
                        type="button"
                        className="pixel-icon-btn pixel-icon-btn--primary"
                        style={{ width: 38, height: 38, minWidth: 38, minHeight: 38 }}
                        onClick={handleContinue}
                        disabled={!isConnected || !draft.trim()}
                        title="Send follow-up"
                      >
                        <SendHorizontal size={16} />
                      </button>
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
