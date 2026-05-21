/**
 * GET /api/fs?path=<dir>
 *
 * Lists the sub-directories of a path so the in-app directory browser can
 * walk the server's filesystem from any browser. This replaces the old
 * localhost-only native macOS folder picker, which popped a dialog on the
 * server's screen — invisible to a remote browser.
 *
 * Only directory *names* are returned, never file contents. This does expose
 * the server's directory tree to anyone who can reach the app, which is
 * consistent with the existing workspace feature (the app already runs the
 * agent CLI in any directory the user names).
 */

import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createLogger } from "@/lib/logger";

const log = createLogger("api/fs");

/** Expand a leading `~` and resolve the input to an absolute path. */
function resolvePath(input: string | null): string {
  const raw = (input ?? "").trim();
  if (!raw || raw === "~") return os.homedir();
  if (raw.startsWith("~/")) return path.resolve(os.homedir(), raw.slice(2));
  return path.resolve(raw);
}

export async function GET(req: Request) {
  const target = resolvePath(new URL(req.url).searchParams.get("path"));

  let stat;
  try {
    stat = await fs.stat(target);
  } catch {
    return NextResponse.json({ error: `Not found: ${target}` }, { status: 404 });
  }
  if (!stat.isDirectory()) {
    return NextResponse.json({ error: `Not a directory: ${target}` }, { status: 400 });
  }

  let entries;
  try {
    entries = await fs.readdir(target, { withFileTypes: true });
  } catch (err) {
    log.warn("readdir failed:", err);
    return NextResponse.json({ error: `Permission denied: ${target}` }, { status: 403 });
  }

  // Directories only, hidden (dot-prefixed) entries skipped, sorted A→Z.
  const dirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => ({ name: e.name, path: path.join(target, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

  const parent = path.dirname(target);

  return NextResponse.json({
    path: target,
    // `dirname` of a filesystem root returns the root itself — surface that
    // as `null` so the browser disables its "up" control there.
    parent: parent === target ? null : parent,
    entries: dirs,
  });
}
