"use client";

import { useCallback, useState } from "react";
import { createLogger } from "../logger";

const log = createLogger("DirectoryPicker");

/**
 * Opens the server-side native folder dialog (macOS) and resolves the picked
 * absolute path, or `undefined` if the user cancels or the picker is
 * unavailable. `picking` is true while the dialog is open.
 */
export function useDirectoryPicker() {
  const [picking, setPicking] = useState(false);

  const pick = useCallback(async (): Promise<string | undefined> => {
    setPicking(true);
    try {
      const res = await fetch("/api/internal/pick-directory", { method: "POST" });
      const data = (await res.json()) as { path?: string; canceled?: boolean; error?: string };
      if (data.error) log.warn("picker unavailable:", data.error);
      return typeof data.path === "string" ? data.path : undefined;
    } catch (err) {
      log.warn("picker request failed:", err);
      return undefined;
    } finally {
      setPicking(false);
    }
  }, []);

  return { pick, picking };
}
