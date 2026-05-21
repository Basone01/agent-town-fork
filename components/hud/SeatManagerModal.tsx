"use client";

import "./seat-manager.css";

import { useEffect, useMemo, useState, useCallback } from "react";
import { X } from "lucide-react";
import { useStudio } from "@/lib/store";
import { createLogger } from "@/lib/logger";

const log = createLogger("SeatManager");
import { WORKER_SPRITES } from "@/components/game/config/animations";
import type { SeatState, SeatType, AgentConfig } from "@/types/game";
import { getAgentProvider } from "@/lib/utils";

const IS_AUGGIE = getAgentProvider() === "auggie";

import SeatList from "./seat-manager/SeatList";
import SeatDetailPanel from "./seat-manager/SeatDetailPanel";

export default function SeatManagerModal({
  open,
  onClose,
  seats,
}: {
  open: boolean;
  onClose: () => void;
  seats: SeatState[];
}) {
  const { updateSeatConfig } = useStudio();
  const [selectedSeatId, setSelectedSeatId] = useState<string>("");
  const [draftSeatId, setDraftSeatId] = useState<string>("");
  const [name, setName] = useState("");
  const [roleTitle, setRoleTitle] = useState("");
  const [spriteKey, setSpriteKey] = useState("");
  const [spritePath, setSpritePath] = useState("");
  const [draftSeatType, setDraftSeatType] = useState<SeatType>("worker");
  const [draftAgentConfig, setDraftAgentConfig] = useState<AgentConfig | undefined>(undefined);
  const [draftModel, setDraftModel] = useState<string>("");

  // Discovered OpenClaw agents
  const [discoveredAgents, setDiscoveredAgents] = useState<AgentConfig[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(false);

  const selectedSeat = useMemo(
    () => seats.find((seat) => seat.seatId === selectedSeatId) ?? seats[0],
    [seats, selectedSeatId],
  );

  const fetchAgents = useCallback(async () => {
    setAgentsLoading(true);
    try {
      const res = await fetch("/api/agents/discover");
      if (res.ok) {
        const data = await res.json();
        setDiscoveredAgents(Array.isArray(data.agents) ? data.agents : []);
      }
    } catch (err) {
      log.error("failed to fetch agents:", err);
    } finally {
      setAgentsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) fetchAgents();
  }, [open, fetchAgents]);

  useEffect(() => {
    if (open && seats.length > 0 && !seats.find((s) => s.seatId === selectedSeatId)) {
      setSelectedSeatId(seats[0].seatId);
    }
  }, [open, seats, selectedSeatId]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open || !selectedSeat) return null;

  const usingDraft = draftSeatId === selectedSeat.seatId;
  const effectiveName = usingDraft ? name : selectedSeat.assigned ? selectedSeat.label : "";
  const effectiveRoleTitle = usingDraft ? roleTitle : (selectedSeat.roleTitle ?? "");
  const effectiveSpriteKey = usingDraft
    ? spriteKey
    : (selectedSeat.spriteKey ?? WORKER_SPRITES[0]?.key ?? "");
  const effectiveSpritePath = usingDraft
    ? spritePath
    : (selectedSeat.spritePath ?? WORKER_SPRITES[0]?.path ?? "");
  const effectiveSeatType = usingDraft ? draftSeatType : (selectedSeat.seatType ?? "worker");
  const effectiveAgentConfig = usingDraft ? draftAgentConfig : selectedSeat.agentConfig;
  const effectiveModel = usingDraft ? draftModel : (selectedSeat.model ?? "");

  const assignedCount = seats.filter((seat) => seat.assigned).length;
  const busy = selectedSeat.status === "running" || selectedSeat.status === "returning";

  const canSaveBase = Boolean(
    effectiveName.trim() &&
    effectiveRoleTitle.trim() &&
    effectiveSpriteKey &&
    effectiveSpritePath &&
    !busy,
  );
  const canSave =
    effectiveSeatType === "agent"
      ? canSaveBase && Boolean(effectiveAgentConfig?.agentId)
      : canSaveBase;

  const beginDraftForSeat = (seat: SeatState) => {
    setDraftSeatId(seat.seatId);
    setName(seat.assigned ? seat.label : "");
    setRoleTitle(seat.roleTitle ?? "");
    setSpriteKey(seat.spriteKey ?? WORKER_SPRITES[0]?.key ?? "");
    setSpritePath(seat.spritePath ?? WORKER_SPRITES[0]?.path ?? "");
    setDraftSeatType(seat.seatType ?? "worker");
    setDraftAgentConfig(seat.agentConfig);
    setDraftModel(seat.model ?? "");
  };

  const handleSelectSeat = (seat: SeatState) => {
    setSelectedSeatId(seat.seatId);
    beginDraftForSeat(seat);
  };

  const handleSave = () => {
    if (!canSave) return;
    updateSeatConfig(selectedSeat.seatId, {
      assigned: true,
      seatType: effectiveSeatType,
      label: effectiveName.trim(),
      roleTitle: effectiveRoleTitle.trim(),
      model: effectiveModel || undefined,
      spriteKey: effectiveSpriteKey,
      spritePath: effectiveSpritePath,
      agentConfig: effectiveSeatType === "agent" ? effectiveAgentConfig : undefined,
    });
  };

  const handleUnassign = () => {
    if (busy) return;
    updateSeatConfig(selectedSeat.seatId, {
      assigned: false,
      seatType: "worker",
      roleTitle: undefined,
      spriteKey: undefined,
      spritePath: undefined,
      agentConfig: undefined,
    });
  };

  const handleSelectAgent = (agent: AgentConfig) => {
    if (!usingDraft) beginDraftForSeat(selectedSeat);
    setDraftAgentConfig(agent);
    setDraftSeatType("agent");
    const agentName = agent.identity?.name ?? agent.agentId;
    setName(agentName);
    setRoleTitle("Independent Agent");
  };

  const handleSwitchType = (type: SeatType) => {
    if (!usingDraft) beginDraftForSeat(selectedSeat);
    setDraftSeatType(type);
    if (type === "worker") {
      setDraftAgentConfig(undefined);
    }
  };

  const handleNameChange = (value: string) => {
    if (!usingDraft) beginDraftForSeat(selectedSeat);
    setName(value);
  };

  const handleRoleTitleChange = (value: string) => {
    if (!usingDraft) beginDraftForSeat(selectedSeat);
    setRoleTitle(value);
  };

  const handleModelChange = (value: string) => {
    if (!usingDraft) beginDraftForSeat(selectedSeat);
    setDraftModel(value);
  };

  const handleSpriteSelect = (key: string, path: string, label: string) => {
    if (!usingDraft) beginDraftForSeat(selectedSeat);
    setSpriteKey(key);
    setSpritePath(path);
    if (!effectiveName.trim()) setName(label);
  };

  // Agents already assigned to other seats (can't double-assign)
  const usedAgentIds = new Set(
    seats
      .filter(
        (s) => s.seatId !== selectedSeat.seatId && s.seatType === "agent" && s.agentConfig?.agentId,
      )
      .map((s) => s.agentConfig!.agentId),
  );

  return (
    <div
      className="seat-manager-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Seat Manager"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="seat-manager pixel-panel">
        {/* Header */}
        <div className="seat-manager__header">
          <div style={{ display: "flex", alignItems: "center", gap: 12, flex: 1, minWidth: 0 }}>
            <div>
              <div style={{ fontSize: 14, color: "var(--pixel-text)" }}>Team Management</div>
              <div style={{ fontSize: 8, color: "var(--pixel-muted)", marginTop: 4 }}>
                {seats.length} seats · {assignedCount} assigned · {seats.length - assignedCount}{" "}
                empty
              </div>
            </div>
            {/* Inline type switcher */}
            <div style={{ display: "flex", gap: 2, marginLeft: "auto" }}>
              <button
                type="button"
                className={`pixel-button ${effectiveSeatType === "worker" ? "pixel-button--primary" : ""}`}
                style={{ fontSize: 7, padding: "3px 10px" }}
                onClick={() => handleSwitchType("worker")}
                disabled={busy}
              >
                Worker
              </button>
              <button
                type="button"
                className={`pixel-button ${effectiveSeatType === "agent" ? "pixel-button--primary" : ""}`}
                style={{ fontSize: 7, padding: "3px 10px" }}
                onClick={() => handleSwitchType("agent")}
                disabled={busy}
              >
                Agent
              </button>
            </div>
          </div>
          <button
            type="button"
            className="pixel-icon-btn"
            style={{ width: 38, height: 38, minWidth: 38, minHeight: 38 }}
            onClick={onClose}
            title="Close"
            aria-label="Close seat manager"
          >
            <X size={16} />
          </button>
        </div>

        <SeatList
          seats={seats}
          selectedSeatId={selectedSeat.seatId}
          onSelectSeat={handleSelectSeat}
        />

        <SeatDetailPanel
          selectedSeat={selectedSeat}
          effectiveName={effectiveName}
          effectiveRoleTitle={effectiveRoleTitle}
          effectiveSpriteKey={effectiveSpriteKey}
          effectiveSpritePath={effectiveSpritePath}
          effectiveSeatType={effectiveSeatType}
          effectiveAgentConfig={effectiveAgentConfig}
          effectiveModel={effectiveModel}
          busy={busy}
          canSave={canSave}
          agentsLoading={agentsLoading}
          discoveredAgents={discoveredAgents}
          usedAgentIds={usedAgentIds}
          onNameChange={handleNameChange}
          onRoleTitleChange={handleRoleTitleChange}
          onModelChange={handleModelChange}
          onSpriteSelect={handleSpriteSelect}
          onSelectAgent={handleSelectAgent}
          onSave={handleSave}
          onUnassign={handleUnassign}
          onClose={onClose}
          isAuggie={IS_AUGGIE}
        />
      </div>
    </div>
  );
}
