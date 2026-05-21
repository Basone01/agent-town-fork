"use client";

import { useState, useMemo } from "react";
import type { TaskItem, TaskStatus } from "@/types/game";
import { formatRelativeTime } from "@/lib/constants";
import HudFlyout from "./HudFlyout";

const STATUS_BUCKET: Record<TaskStatus, "running" | "failed" | "draft" | "stopped" | "done"> = {
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

function combineGroupStatus(items: TaskItem[]): TaskStatus {
  const buckets = new Set(items.map((t) => STATUS_BUCKET[t.status]));
  if (buckets.has("running")) return "running";
  if (buckets.has("failed")) return "failed";
  if (buckets.has("draft")) return "draft";
  if (buckets.has("stopped")) return "stopped";
  return "completed";
}

function taskStatusLabel(status: TaskItem["status"]) {
  switch (status) {
    case "queued":
      return "queued";
    case "returning":
      return "returning";
    case "submitted":
      return "sending";
    case "stopped":
      return "stopped";
    case "completed":
      return "done";
    default:
      return status;
  }
}

interface TaskGroup {
  sessionKey: string;
  tasks: TaskItem[];
  latest: TaskItem;
  combinedStatus: TaskStatus;
}

export default function TaskPanel({
  tasks,
  onExpand,
  onSelectTask,
}: {
  tasks: TaskItem[];
  onExpand: () => void;
  onSelectTask: (taskId: string) => void;
}) {
  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(() => new Set());

  const runningTasks = tasks.filter((task) =>
    ["running", "submitted", "queued", "returning"].includes(task.status),
  );

  const groups = useMemo<TaskGroup[]>(() => {
    const sorted = [...tasks].sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
    const bySession = new Map<string, TaskItem[]>();
    for (const task of sorted) {
      const bucket = bySession.get(task.sessionKey);
      if (bucket) bucket.push(task);
      else bySession.set(task.sessionKey, [task]);
    }
    return [...bySession.values()].map((grp) => ({
      sessionKey: grp[0].sessionKey,
      tasks: grp,
      latest: grp[0],
      combinedStatus: combineGroupStatus(grp),
    }));
  }, [tasks]);

  const toggleSession = (sessionKey: string) => {
    setExpandedSessions((prev) => {
      const next = new Set(prev);
      if (next.has(sessionKey)) next.delete(sessionKey);
      else next.add(sessionKey);
      return next;
    });
  };

  return (
    <HudFlyout
      title="Tasks"
      subtitle={`${runningTasks.length} active / ${tasks.length} total`}
      headerAction={
        <button
          type="button"
          className="pixel-button pixel-button--primary"
          style={{ fontSize: 7, padding: "4px 8px" }}
          onClick={onExpand}
        >
          Expand
        </button>
      }
    >
      <div className="hud-list">
        {tasks.length === 0 ? (
          <div className="hud-empty">No tasks yet.</div>
        ) : (
          groups.map((group) => {
            if (group.tasks.length === 1) {
              const task = group.tasks[0];
              return (
                <button
                  key={task.taskId}
                  type="button"
                  className="hud-list__item"
                  onClick={() => onSelectTask(task.taskId)}
                  title="Open in Task View"
                >
                  <div className="hud-list__top">
                    <span className={`hud-status hud-status--${task.status}`}>
                      {taskStatusLabel(task.status)}
                    </span>
                    <span>{formatRelativeTime(task.completedAt ?? task.createdAt)}</span>
                  </div>
                  <div className="hud-list__title">{task.title ?? task.message}</div>
                </button>
              );
            }

            const expanded = expandedSessions.has(group.sessionKey);
            return (
              <div key={group.sessionKey} className="hud-list__group">
                <button
                  type="button"
                  className="hud-list__group-header"
                  onClick={() => toggleSession(group.sessionKey)}
                  aria-expanded={expanded}
                  title="Toggle session group"
                >
                  <div className="hud-list__top">
                    <span className="hud-list__group-label">
                      <span className="hud-list__group-chevron">{expanded ? "▾" : "▸"}</span>
                      <span className={`hud-status hud-status--${group.combinedStatus}`}>
                        {taskStatusLabel(group.combinedStatus)}
                      </span>
                    </span>
                    <span>
                      {formatRelativeTime(group.latest.completedAt ?? group.latest.createdAt)}
                    </span>
                  </div>
                  <div className="hud-list__title">
                    {group.latest.title ?? group.latest.message}
                  </div>
                  <div className="hud-list__group-sub">
                    {group.tasks.length} tasks · {group.sessionKey.slice(-6)}
                  </div>
                </button>
                {expanded && (
                  <div className="hud-list__group-children">
                    {group.tasks.map((task) => (
                      <button
                        key={task.taskId}
                        type="button"
                        className="hud-list__item hud-list__item--child"
                        onClick={() => onSelectTask(task.taskId)}
                        title="Open in Task View"
                      >
                        <div className="hud-list__top">
                          <span className={`hud-status hud-status--${task.status}`}>
                            {taskStatusLabel(task.status)}
                          </span>
                          <span>{formatRelativeTime(task.completedAt ?? task.createdAt)}</span>
                        </div>
                        <div className="hud-list__title">{task.title ?? task.message}</div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </HudFlyout>
  );
}
