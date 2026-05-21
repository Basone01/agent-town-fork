"use client";

import { useStudio } from "@/lib/store";
import { STATUS_LABELS } from "@/lib/constants";
import HudFlyout from "./HudFlyout";

/**
 * Connection panel — status only.
 *
 * Agent Town talks to a local Claude bridge, so there is no gateway URL or
 * token to enter. The store auto-connects on load; this panel just surfaces
 * status and a manual reconnect control.
 */
export default function ConnectionPanel() {
  const { state, connect, disconnect } = useStudio();
  const isConnected = state.connection === "connected";
  const isConnecting = state.connection === "connecting";
  const isError =
    state.connection === "error" ||
    state.connection === "auth_failed" ||
    state.connection === "unreachable" ||
    state.connection === "rate_limited";

  return (
    <HudFlyout title="Connection" subtitle={`${STATUS_LABELS[state.connection]} (Claude)`}>
      <div className="hud-panel__stack">
        <p style={{ color: "var(--pixel-muted)", fontSize: "8px" }}>
          Workers run on the local <code>claude</code> CLI. Make sure <code>claude</code> is
          installed and authenticated.
        </p>
        {isError && (
          <p style={{ color: "var(--pixel-red)", fontSize: "8px" }}>
            The Claude bridge is unreachable. Try reconnecting.
          </p>
        )}
        {!isConnected && !isConnecting && (
          <button
            type="button"
            className="pixel-button pixel-button--primary"
            onClick={() => connect()}
          >
            Connect
          </button>
        )}
        {isConnected && (
          <button type="button" className="pixel-button" onClick={disconnect}>
            Disconnect
          </button>
        )}
        {isConnecting && (
          <button type="button" className="pixel-button" onClick={disconnect}>
            Cancel
          </button>
        )}
      </div>
    </HudFlyout>
  );
}
