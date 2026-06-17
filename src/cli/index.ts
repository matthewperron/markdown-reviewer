#!/usr/bin/env bun
import { resolve, join } from "node:path";
import { access, constants, rm } from "node:fs/promises";
import { networkInterfaces, homedir, tmpdir } from "node:os";
import qrcode from "qrcode-terminal";
import { startServer, SessionLockedError } from "../server/index";
import { cleanupFile } from "../server/session-manifest";

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

const usage = `
Usage: mdr <path-to-markdown> [options]

Options:
  --port <n>         Port for the local server (default: auto-select)
  --tmp-dir <dir>    Root for annotation session storage (default: /tmp/markdown-review on Unix, %APPDATA%/markdown-review/tmp on Windows)
  --no-open          Don't auto-open the browser
  --lan              Expose the server on the local network and print a QR code (implies --no-open)
  --host <host>      Public LAN URL host for --lan QR codes (default: detected IPv4)
  --fresh            Discard existing session, start clean
  --auto-discover    Crawl the relative-.md link graph and add reachable files to session
  --pi <port>        Pi integration — enable "Send to pi" callback on given port
  --cleanup <file>   Mark a reviewed file as applied: remove its annotations and session data
  --clean            Delete all session data (manifests, markers, annotations) and exit
  -h, --help         Show this help message

Configuration:
  Persistent defaults can be set in an env file at
  $XDG_CONFIG_HOME/mdr/config.env (default ~/.config/mdr/config.env on Unix,
  %APPDATA%/markdown-review/config.env on Windows), e.g.:
    MDR_LAN=1
    MDR_PORT=7000
    MDR_HOST=your-host.local
  Supported keys: MDR_PORT, MDR_HOST, MDR_LAN, MDR_TMP_DIR, MDR_NO_OPEN,
  MDR_AUTO_DISCOVER. Precedence: file < MDR_* environment variables < CLI flags.
`.trim();

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
  filePath?: string;
  port?: number;
  tmpDir: string;
  noOpen: boolean;
  lan: boolean;
  host?: string;
  fresh: boolean;
  autoDiscover: boolean;
  piPort?: number;
  cleanupFile?: string;
  clean: boolean;
  help: boolean;
}

// ---------------------------------------------------------------------------
// Config file (~/.config/mdr/config.env)
// ---------------------------------------------------------------------------

const CONFIG_KEYS = [
  "MDR_PORT",
  "MDR_HOST",
  "MDR_LAN",
  "MDR_TMP_DIR",
  "MDR_NO_OPEN",
  "MDR_AUTO_DISCOVER",
] as const;

export function configEnvPath(): string {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    if (appData) return join(appData, "markdown-review", "config.env");
    return join(homedir(), "AppData", "Roaming", "markdown-review", "config.env");
  }
  const base = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(base, "mdr", "config.env");
}

export function parseEnvFile(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

export async function loadConfigEnv(path: string = configEnvPath()): Promise<Record<string, string>> {
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) return {};
    return parseEnvFile(await file.text());
  } catch {
    return {};
  }
}

/** Parse a port string, returning null when it is not a valid 0–65535 port. */
export function parsePortValue(val: string): number | null {
  const n = Number(val);
  if (!Number.isFinite(n) || n < 0 || n > 65535) return null;
  return n;
}

export function parseBool(val: string): boolean {
  return /^(1|true|yes|on)$/i.test(val.trim());
}

export interface ConfigResolution {
  defaults: Partial<ParsedArgs>;
  /** Validation problems with config values; surfaced only on the normal run path. */
  errors: string[];
}

/**
 * Resolve persistent defaults from a config-file record, with real `MDR_*`
 * environment variables taking precedence over file values. The result seeds
 * parseArgs (CLI flags then override it). Invalid values are collected as
 * `errors` rather than exiting, so commands that don't need them (e.g. --help,
 * --clean) still work with a malformed config file.
 */
export function resolveConfigDefaults(record: Record<string, string>): ConfigResolution {
  const merged: Record<string, string> = { ...record };
  for (const key of CONFIG_KEYS) {
    const envVal = process.env[key];
    if (envVal !== undefined) merged[key] = envVal;
  }

  const defaults: Partial<ParsedArgs> = {};
  const errors: string[] = [];

  if (merged.MDR_PORT !== undefined) {
    const port = parsePortValue(merged.MDR_PORT);
    if (port === null) {
      errors.push(`MDR_PORT must be a number between 0 and 65535, got "${merged.MDR_PORT}"`);
    } else {
      defaults.port = port;
    }
  }
  if (merged.MDR_HOST !== undefined) {
    try {
      defaults.host = normalizePublicHost(merged.MDR_HOST);
    } catch (err: any) {
      errors.push(`invalid MDR_HOST: ${err.message}`);
    }
  }
  if (merged.MDR_LAN !== undefined) defaults.lan = parseBool(merged.MDR_LAN);
  if (merged.MDR_TMP_DIR !== undefined) defaults.tmpDir = merged.MDR_TMP_DIR;
  if (merged.MDR_NO_OPEN !== undefined) defaults.noOpen = parseBool(merged.MDR_NO_OPEN);
  if (merged.MDR_AUTO_DISCOVER !== undefined) defaults.autoDiscover = parseBool(merged.MDR_AUTO_DISCOVER);
  return { defaults, errors };
}

function getDefaultTmpDir(): string {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    if (appData) return join(appData, "markdown-review", "tmp");
    return join(homedir(), "AppData", "Roaming", "markdown-review", "tmp");
  }
  return join(tmpdir(), "markdown-review");
}

function parseArgs(argv: string[], configDefaults: Partial<ParsedArgs> = {}): ParsedArgs {
  const args: ParsedArgs = {
    tmpDir: getDefaultTmpDir(),
    noOpen: false,
    lan: false,
    fresh: false,
    autoDiscover: false,
    clean: false,
    help: false,
    ...configDefaults,
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];

    if (arg === "--help" || arg === "-h") {
      args.help = true;
      i++;
      continue;
    }

    if (arg === "--port") {
      const val = argv[++i];
      if (val === undefined) {
        console.error("Error: --port requires a value");
        process.exit(1);
      }
      const port = parsePortValue(val);
      if (port === null) {
        console.error(`Error: --port value must be a number between 0 and 65535, got "${val}"`);
        process.exit(1);
      }
      args.port = port;
      i++;
      continue;
    }

    if (arg === "--tmp-dir") {
      const val = argv[++i];
      if (val === undefined) {
        console.error("Error: --tmp-dir requires a value");
        process.exit(1);
      }
      args.tmpDir = val;
      i++;
      continue;
    }

    if (arg === "--no-open") {
      args.noOpen = true;
      i++;
      continue;
    }

    if (arg === "--lan") {
      args.lan = true;
      i++;
      continue;
    }

    if (arg === "--host") {
      const val = argv[++i];
      if (val === undefined) {
        console.error("Error: --host requires a value");
        process.exit(1);
      }
      try {
        args.host = normalizePublicHost(val);
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
      i++;
      continue;
    }

    if (arg === "--fresh") {
      args.fresh = true;
      i++;
      continue;
    }

    if (arg === "--auto-discover") {
      args.autoDiscover = true;
      i++;
      continue;
    }

    if (arg === "--pi") {
      const val = argv[++i];
      if (val === undefined) {
        console.error("Error: --pi requires a value");
        process.exit(1);
      }
      const port = parsePortValue(val);
      if (port === null) {
        console.error(`Error: --pi value must be a number between 0 and 65535, got "${val}"`);
        process.exit(1);
      }
      args.piPort = port;
      i++;
      continue;
    }

    if (arg === "--cleanup") {
      const val = argv[++i];
      if (val === undefined) {
        console.error("Error: --cleanup requires a value");
        process.exit(1);
      }
      args.cleanupFile = val;
      i++;
      continue;
    }

    if (arg === "--clean") {
      args.clean = true;
      i++;
      continue;
    }

    // Positional arg (first non-flag)
    if (!arg.startsWith("-")) {
      if (args.filePath === undefined) {
        args.filePath = arg;
      }
      i++;
      continue;
    }

    // Unknown flag
    console.error(`Error: unknown option "${arg}"`);
    process.exit(1);
  }

  return args;
}

// ---------------------------------------------------------------------------
// Browser open
// ---------------------------------------------------------------------------

function getOpenCommand(): string {
  if (process.platform === "win32") return "start";
  if (process.platform === "darwin") return "open";
  return "xdg-open";
}

async function openBrowser(url: string): Promise<void> {
  // Spawn the opener directly (not via sh) — sh would look for a script file
  // named "open"/"xdg-open" rather than the command itself.
  // On Windows, use `start "" "url"` so the empty string is the window title
  // and the URL is treated as the target (fixes URLs being parsed as titles).
  const args = process.platform === "win32"
    ? ["/c", `start "" "${url}"`]
    : [getOpenCommand(), url];
  const cmd = process.platform === "win32" ? "cmd" : getOpenCommand();

  try {
    const proc = process.platform === "win32"
      ? Bun.spawn(["cmd", ...args], {
          stdio: ["inherit", "inherit", "inherit"],
        })
      : Bun.spawn([cmd, url], {
          stdio: ["inherit", "inherit", "inherit"],
        });
    await proc.exited;
  } catch {
    // Non-fatal — URL is already printed
  }
}

export function shouldOpenBrowser(args: Pick<ParsedArgs, "noOpen" | "lan">): boolean {
  return !args.noOpen && !args.lan;
}

// ---------------------------------------------------------------------------
// LAN URL helpers
// ---------------------------------------------------------------------------

export function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }

  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true;
  return a === 192 && b === 168;
}

function compareIpv4(a: string, b: string): number {
  const aParts = a.split(".").map((part) => Number(part));
  const bParts = b.split(".").map((part) => Number(part));
  for (let i = 0; i < 4; i++) {
    const diff = (aParts[i] ?? 0) - (bParts[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function privateIpv4Rank(address: string): number {
  if (address.startsWith("192.168.")) return 0;
  if (address.startsWith("10.")) return 1;
  if (address.startsWith("172.")) return 2;
  return 3;
}

export function getLanIpv4Address(
  interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): string | null {
  const candidates: string[] = [];

  for (const entries of Object.values(interfaces)) {
    if (!entries) continue;
    for (const entry of entries) {
      // IPv6 link-local URLs need interface scopes and bracket syntax, which
      // makes terminal QR sharing brittle. LAN QR output is IPv4-only by design.
      if (entry.family !== "IPv4" || entry.internal) continue;
      if (entry.address.startsWith("169.254.")) continue;
      candidates.push(entry.address);
    }
  }

  candidates.sort((a, b) => {
    const rankDiff = privateIpv4Rank(a) - privateIpv4Rank(b);
    return rankDiff || compareIpv4(a, b);
  });

  return candidates.find(isPrivateIpv4) ?? candidates[0] ?? null;
}

export function renderTerminalQr(url: string): string {
  let output = "";
  qrcode.generate(url, { small: true }, (qr) => {
    output = qr;
  });
  return output;
}

export function normalizePublicHost(host: string): string {
  const normalized = host.trim();
  if (!normalized) {
    throw new Error("--host value must not be empty");
  }
  if (normalized.includes("://") || /[/?#:\s]/.test(normalized)) {
    throw new Error("--host value must be a host name or address without scheme, path, port, or spaces");
  }
  return normalized;
}

function formatHostForUrl(host: string): string {
  if (host.startsWith("[") && host.endsWith("]")) return host;
  return host.includes(":") ? `[${host}]` : host;
}

export interface PrintLanAccessOptions {
  host?: string | null;
  interfaces?: ReturnType<typeof networkInterfaces>;
  logger?: Pick<typeof console, "log" | "warn">;
  renderQr?: (url: string) => string;
}

export function printLanAccess(port: number, options: PrintLanAccessOptions = {}): void {
  const logger = options.logger ?? console;
  const lanHost = options.host === undefined
    ? getLanIpv4Address(options.interfaces)
    : options.host;

  if (!lanHost) {
    logger.warn("LAN mode enabled, but no non-internal IPv4 address was found. Skipping LAN URL and QR code.");
    return;
  }

  const renderQr = options.renderQr ?? renderTerminalQr;
  const lanUrl = `http://${formatHostForUrl(lanHost)}:${port}`;
  logger.log(`LAN URL: ${lanUrl}`);
  logger.log("Security: LAN mode is opt-in. Devices that can reach this URL can view this session, add/edit/delete annotations, and regenerate .mdr files.");
  logger.log(renderQr(lanUrl));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const rawArgs = process.argv.slice(2);

  // Help needs nothing from the config file; handle it before loading so a
  // malformed config can't prevent the user from reading the help text.
  if (rawArgs.includes("-h") || rawArgs.includes("--help")) {
    console.log(usage);
    process.exit(0);
  }

  const { defaults: configDefaults, errors: configErrors } = resolveConfigDefaults(
    await loadConfigEnv(),
  );
  const args = parseArgs(rawArgs, configDefaults);

  // --cleanup <file>: remove session data for a single reviewed file
  if (args.cleanupFile) {
    try {
      const cleanupPath = resolve(args.cleanupFile);
      await cleanupFile(cleanupPath, args.tmpDir);
      console.log(`Cleanup done: ${cleanupPath}`);
      process.exit(0);
    } catch (err: any) {
      console.error(`Error cleaning up session: ${err.message}`);
      process.exit(1);
    }
  }

  // --clean: delete all session data and exit. It only needs tmpDir, so it runs
  // before surfacing config-value errors (a bad MDR_PORT shouldn't block a clean).
  if (args.clean) {
    try {
      await rm(args.tmpDir, { recursive: true, force: true });
      console.log(`Session data cleaned: ${args.tmpDir}`);
      process.exit(0);
    } catch (err: any) {
      console.error(`Error cleaning session data: ${err.message}`);
      process.exit(1);
    }
  }

  // Surface invalid config values on the normal run path.
  if (configErrors.length > 0) {
    for (const err of configErrors) console.error(`Error: ${err}`);
    process.exit(1);
  }

  // Require positional path
  if (!args.filePath) {
    console.error("Error: missing required argument <path-to-markdown>");
    console.error("");
    console.error(usage);
    process.exit(1);
  }

  if (args.host && !args.lan) {
    // An explicit --host flag without --lan is a usage error. A host coming
    // only from config/env is non-fatal: warn and ignore so a leftover
    // MDR_HOST doesn't block runs.
    if (rawArgs.includes("--host")) {
      console.error("Error: --host requires --lan");
      process.exit(1);
    }
    console.warn(
      "Warning: MDR_HOST is set but LAN mode is off; ignoring it. Set MDR_LAN=1 (or pass --lan) to use it.",
    );
    args.host = undefined;
  }

  // Resolve to absolute path
  const filePath = resolve(args.filePath);

  // Validate file exists and is readable
  try {
    await access(filePath, constants.R_OK);
  } catch {
    console.error(`Error: file not found or not readable: ${filePath}`);
    process.exit(1);
  }

  // Start the server
  let server: Awaited<ReturnType<typeof startServer>> | null = null;
  const lanHost = args.lan ? (args.host ?? getLanIpv4Address()) : null;

  try {
    server = await startServer({
      filePath,
      port: args.port,
      tmpDir: args.tmpDir,
      fresh: args.fresh,
      autoDiscover: args.autoDiscover,
      lan: args.lan,
      allowedHosts: lanHost ? [lanHost] : undefined,
      piPort: args.piPort,
    });
  } catch (err) {
    if (err instanceof SessionLockedError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  // Print URL (always)
  console.log(`markdown-reviewer running at ${server.url}`);
  if (args.lan) {
    printLanAccess(server.port, { host: lanHost });
  }

  // Open browser unless suppressed explicitly or by LAN mode.
  if (shouldOpenBrowser(args)) {
    openBrowser(server.url);
  }

  // Signal handling — release lock on Ctrl-C / SIGTERM
  let stopping = false;
  const cleanup = async () => {
    if (stopping) return;
    stopping = true;
    if (server) {
      await server.stop();
    }
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  // Wait for server to stop (self-shutdown after POST /api/done, or signal handler).
  // The signal handler calls stop() which resolves the stopped promise,
  // so this catches both cases.
  await server.stopped;
  process.exit(0);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`Fatal: ${err.message}`);
    process.exit(1);
  });
}
