/**
 * GET /api/workspace
 *
 * Returns the server's default workspace directory — the cwd Claude workers
 * run in when a task doesn't name its own. This is the same value the bridge
 * resolves in `getWorkspaceDir()` (`server.ts` pins it into the env at boot).
 *
 * The in-app workspace field fetches this so a blank input can still *show*
 * where "use the server default" actually points, instead of leaving the
 * user guessing.
 */

import { NextResponse } from "next/server";

// Read the live env value per request — never statically cache this route.
export const dynamic = "force-dynamic";

export function GET() {
  const dir = process.env.CLAUDE_WORKSPACE_DIR ?? process.cwd();
  return NextResponse.json({ dir });
}
