"use client";

import type { TaskItem } from "@/types/game";
import { formatRelativeTime } from "@/lib/constants";
import HudFlyout from "./HudFlyout";

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
    default:
      return status;
  }
}

export default function TaskPanel({
  tasks,
  onExpand,
}: {
  tasks: TaskItem[];
  onExpand: () => void;
}) {
  const runningTasks = tasks.filter((task) =>
    ["running", "submitted", "queued", "returning"].includes(task.status),
  );

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
          tasks.map((task) => (
            <div key={task.taskId} className="hud-list__item">
              <div className="hud-list__top">
                <span className={`hud-status hud-status--${task.status}`}>
                  {taskStatusLabel(task.status)}
                </span>
                <span>{formatRelativeTime(task.completedAt ?? task.createdAt)}</span>
              </div>
              <div className="hud-list__title">{task.message}</div>
            </div>
          ))
        )}
      </div>
    </HudFlyout>
  );
}
