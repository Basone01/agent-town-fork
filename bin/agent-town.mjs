#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const pkgPath = resolve(root, "package.json");

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`
  \x1b[36m\x1b[1mAgent Town\x1b[0m  Pixel-style AI Agent collaboration community

  Runs your AI workers with the local \x1b[1mclaude\x1b[0m CLI (Claude Code) by
  default. Make sure the chosen provider's CLI is installed and authenticated.

  Usage
    $ agent-town [options]

  Options
    --provider  <name>    Agent provider: claude|auggie        (default: claude)
    --port      <number>  Port to listen on                    (default: 3000)
    --workspace <dir>     Directory claude workers operate in   (default: cwd)
    --model     <name>    Default claude model: opus|sonnet|haiku (default: sonnet)
    -v, --version         Show version
    -h, --help            Show this help message

  Examples
    $ agent-town
    $ agent-town --provider auggie
    $ agent-town --port 8080
    $ agent-town --workspace ~/projects/my-app
    $ agent-town --model opus
`);
  process.exit(0);
}

if (args.includes("--version") || args.includes("-v")) {
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  console.log(pkg.version);
  process.exit(0);
}

function getArg(flag) {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
  return undefined;
}

const port = getArg("--port");
const workspace = getArg("--workspace");
const model = getArg("--model");
const provider = getArg("--provider");

if (port) process.env.PORT = port;
if (model) process.env.CLAUDE_MODEL = model;
if (provider) {
  process.env.AGENT_PROVIDER = provider;
  process.env.NEXT_PUBLIC_AGENT_PROVIDER = provider;
}
// Workers operate on the directory agent-town was launched from unless told otherwise.
process.env.CLAUDE_WORKSPACE_DIR =
  (workspace && resolve(process.cwd(), workspace)) ??
  process.env.CLAUDE_WORKSPACE_DIR ??
  process.cwd();
process.env.NODE_ENV = "production";

const serverPath = resolve(root, ".next", "standalone", "server.prod.mjs");
await import(serverPath);
