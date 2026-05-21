"use client";

import { useStudio } from "@/lib/store";
import { STATUS_LABELS } from "@/lib/constants";
import { getAgentProvider } from "@/lib/utils";
import HudFlyout from "./HudFlyout";

/**
 * Connection panel — status only.
 *
 * Both providers (claude / auggie) are local bridges, so there is no gateway
 * URL or token to enter. The store auto-connects on load; this panel just
 * surfaces status and a manual reconnect control.
 */
const PROVIDER = getAgentProvider();
const PROVIDER_NAME = PROVIDER === "auggie" ? "Auggie" : "Claude";
const PROVIDER_CLI = PROVIDER === "auggie" ? "auggie" : "claude";

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
    <HudFlyout
      title="Connection"
      subtitle={`${STATUS_LABELS[state.connection]} (${PROVIDER_NAME})`}
    >
      <div className="hud-panel__stack">
        <p style={{ color: "var(--pixel-muted)", fontSize: "8px" }}>
          Workers run on the local <code>{PROVIDER_CLI}</code> CLI. Make sure{" "}
          <code>{PROVIDER_CLI}</code> is installed and authenticated.
        </p>
        {isError && (
          <p style={{ color: "var(--pixel-red)", fontSize: "8px" }}>
            The {PROVIDER_NAME} bridge is unreachable. Try reconnecting.
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
