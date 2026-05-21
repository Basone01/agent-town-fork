/**
 * Native directory picker — localhost-only internal endpoint.
 *
 * Browsers cannot expose absolute filesystem paths, but Agent Town's server
 * runs on the user's machine, so it can drive the OS-native folder chooser.
 * On macOS this spawns `osascript` (`choose folder`) and returns the picked
 * POSIX path. Shared by server.ts (dev) and server.prod.mjs (standalone).
 */

import { execFile } from "node:child_process";

/** Show the macOS folder chooser and resolve the picked absolute path. */
function chooseFolder() {
  return new Promise((resolve) => {
    if (process.platform !== "darwin") {
      resolve({ error: "Native folder picker is only available on macOS — type the path instead" });
      return;
    }
    // `activate` brings the dialog to the front; the chooser blocks until the
    // user picks or cancels (cancel → osascript exits non-zero with -128).
    const script =
      'activate\nPOSIX path of (choose folder with prompt "Select workspace directory")';
    execFile("osascript", ["-e", script], { timeout: 300_000 }, (err, stdout, stderr) => {
      if (err) {
        const detail = `${stderr || ""} ${err.message || ""}`;
        if (/user canceled|-128/i.test(detail)) {
          resolve({ canceled: true });
        } else {
          resolve({ error: (stderr || err.message).trim() || "Folder picker failed" });
        }
        return;
      }
      const path = stdout.trim().replace(/\/+$/, "");
      resolve(path ? { path } : { canceled: true });
    });
  });
}

/** HTTP handler for POST /api/internal/pick-directory (localhost only). */
export function handlePickDirectory(req, res) {
  const json = (code, obj) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
  };

  if (req.method !== "POST") {
    json(405, { error: "Method not allowed" });
    return;
  }
  const remoteIp = req.socket.remoteAddress;
  if (remoteIp !== "127.0.0.1" && remoteIp !== "::1" && remoteIp !== "::ffff:127.0.0.1") {
    json(403, { error: "Forbidden" });
    return;
  }

  chooseFolder()
    .then((result) => json(result.error ? 500 : 200, result))
    .catch((err) => json(500, { error: err.message }));
}
