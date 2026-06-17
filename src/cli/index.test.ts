import { afterEach, describe, expect, test } from "bun:test";
import type { NetworkInterfaceInfo } from "node:os";
import {
  configEnvPath,
  getLanIpv4Address,
  isPrivateIpv4,
  loadConfigEnv,
  normalizePublicHost,
  parseBool,
  parseEnvFile,
  printLanAccess,
  renderTerminalQr,
  resolveConfigDefaults,
  shouldOpenBrowser,
} from "./index";

function ipv4(address: string, internal = false): NetworkInterfaceInfo {
  return {
    address,
    family: "IPv4",
    internal,
    mac: "00:00:00:00:00:00",
    netmask: "255.255.255.0",
    cidr: `${address}/24`,
  };
}

function ipv6(address: string, internal = false): NetworkInterfaceInfo {
  return {
    address,
    family: "IPv6",
    internal,
    mac: "00:00:00:00:00:00",
    netmask: "ffff:ffff:ffff:ffff::",
    cidr: `${address}/64`,
    scopeid: 0,
  };
}

describe("CLI LAN helpers", () => {
  test("shouldOpenBrowser is false for --no-open and LAN mode", () => {
    expect(shouldOpenBrowser({ noOpen: false, lan: false })).toBe(true);
    expect(shouldOpenBrowser({ noOpen: true, lan: false })).toBe(false);
    expect(shouldOpenBrowser({ noOpen: false, lan: true })).toBe(false);
    expect(shouldOpenBrowser({ noOpen: true, lan: true })).toBe(false);
  });

  test("isPrivateIpv4 detects private ranges and rejects invalid/link-local addresses", () => {
    expect(isPrivateIpv4("10.0.0.1")).toBe(true);
    expect(isPrivateIpv4("192.168.1.1")).toBe(true);
    expect(isPrivateIpv4("172.16.0.1")).toBe(true);
    expect(isPrivateIpv4("172.31.255.255")).toBe(true);

    expect(isPrivateIpv4("172.15.0.1")).toBe(false);
    expect(isPrivateIpv4("172.32.0.1")).toBe(false);
    expect(isPrivateIpv4("8.8.8.8")).toBe(false);
    expect(isPrivateIpv4("169.254.1.1")).toBe(false);
    expect(isPrivateIpv4("invalid")).toBe(false);
    expect(isPrivateIpv4("192.168.1.999")).toBe(false);
  });

  test("getLanIpv4Address excludes internal/link-local addresses and prefers common private LANs", () => {
    const interfaces = {
      lo0: [
        ipv4("127.0.0.1", true),
      ],
      en0: [
        ipv6("fe80::1"),
        ipv4("10.0.0.5"),
      ],
      en1: [
        ipv4("169.254.10.20"),
        ipv4("192.168.1.10"),
      ],
    } as ReturnType<typeof import("node:os").networkInterfaces>;

    expect(getLanIpv4Address(interfaces)).toBe("192.168.1.10");
  });

  test("getLanIpv4Address falls back to a non-private external IPv4", () => {
    const interfaces = {
      en0: [
        ipv4("203.0.113.10"),
      ],
    } as ReturnType<typeof import("node:os").networkInterfaces>;

    expect(getLanIpv4Address(interfaces)).toBe("203.0.113.10");
  });

  test("normalizePublicHost rejects schemes, paths, spaces, and empty values", () => {
    expect(normalizePublicHost(" dev-machine ")).toBe("dev-machine");

    expect(() => normalizePublicHost("")).toThrow("--host value must not be empty");
    expect(() => normalizePublicHost("http://dev-machine")).toThrow("without scheme");
    expect(() => normalizePublicHost("dev-machine/path")).toThrow("without scheme");
    expect(() => normalizePublicHost("dev-machine:11222")).toThrow("without scheme");
    expect(() => normalizePublicHost("dev machine")).toThrow("without scheme");
  });

  test("renderTerminalQr returns terminal output", () => {
    expect(renderTerminalQr("http://192.168.1.10:3000").length).toBeGreaterThan(0);
  });

  test("printLanAccess uses the configured public host and prints side-effect warning", () => {
    const logs: string[] = [];
    const warnings: string[] = [];

    printLanAccess(11222, {
      host: "dev-machine",
      logger: {
        log: (message) => logs.push(message),
        warn: (message) => warnings.push(message),
      },
      renderQr: (url) => `QR:${url}`,
    });

    expect(warnings).toEqual([]);
    expect(logs[0]).toBe("LAN URL: http://dev-machine:11222");
    expect(logs[1]).toContain("add/edit/delete annotations");
    expect(logs[1]).toContain("regenerate .mdr files");
    expect(logs[2]).toBe("QR:http://dev-machine:11222");
  });

  test("printLanAccess warns when no LAN host is available", () => {
    const logs: string[] = [];
    const warnings: string[] = [];

    printLanAccess(3000, {
      host: null,
      logger: {
        log: (message) => logs.push(message),
        warn: (message) => warnings.push(message),
      },
    });

    expect(logs).toEqual([]);
    expect(warnings).toEqual([
      "LAN mode enabled, but no non-internal IPv4 address was found. Skipping LAN URL and QR code.",
    ]);
  });
});

describe("CLI config file", () => {
  const savedEnv: Record<string, string | undefined> = {};
  const configKeys = [
    "MDR_PORT",
    "MDR_HOST",
    "MDR_LAN",
    "MDR_TMP_DIR",
    "MDR_NO_OPEN",
    "MDR_AUTO_DISCOVER",
    "XDG_CONFIG_HOME",
  ];

  function clearConfigEnv() {
    for (const key of configKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  }

  afterEach(() => {
    for (const key of configKeys) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("parseEnvFile handles KEY=VALUE, comments, blanks, and quotes", () => {
    const record = parseEnvFile(
      [
        "# a comment",
        "",
        "MDR_LAN=1",
        "MDR_PORT = 7000",
        'MDR_HOST="your-host.local"',
        "MDR_TMP_DIR='/var/tmp/mdr'",
        "  # indented comment",
        "MALFORMED_NO_EQUALS",
        "=novalue",
      ].join("\n"),
    );

    expect(record).toEqual({
      MDR_LAN: "1",
      MDR_PORT: "7000",
      MDR_HOST: "your-host.local",
      MDR_TMP_DIR: "/var/tmp/mdr",
    });
  });

  test("parseBool recognizes truthy tokens only", () => {
    for (const v of ["1", "true", "TRUE", "yes", "on"]) expect(parseBool(v)).toBe(true);
    for (const v of ["0", "false", "no", "off", "", "foo"]) expect(parseBool(v)).toBe(false);
  });

  test("loadConfigEnv returns {} for a missing file", async () => {
    expect(await loadConfigEnv("/nonexistent/path/to/config.env")).toEqual({});
  });

  test("configEnvPath honors XDG_CONFIG_HOME (Unix only)", () => {
    if (process.platform === "win32") {
      // On Windows, configEnvPath uses APPDATA, not XDG_CONFIG_HOME
      return;
    }
    clearConfigEnv();
    process.env.XDG_CONFIG_HOME = "/custom/cfg";
    expect(configEnvPath()).toBe("/custom/cfg/mdr/config.env");
  });

  test("resolveConfigDefaults coerces and normalizes file values", () => {
    clearConfigEnv();
    const { defaults, errors } = resolveConfigDefaults({
      MDR_LAN: "1",
      MDR_PORT: "7000",
      MDR_HOST: " your-host.local ",
      MDR_NO_OPEN: "false",
    });

    expect(errors).toEqual([]);
    expect(defaults).toEqual({
      lan: true,
      port: 7000,
      host: "your-host.local",
      noOpen: false,
    });
  });

  test("real MDR_* env vars override file values", () => {
    clearConfigEnv();
    process.env.MDR_PORT = "8000";
    const { defaults } = resolveConfigDefaults({ MDR_PORT: "7000" });
    expect(defaults.port).toBe(8000);
  });

  test("resolveConfigDefaults omits keys that are not set", () => {
    clearConfigEnv();
    expect(resolveConfigDefaults({})).toEqual({ defaults: {}, errors: [] });
  });

  test("resolveConfigDefaults collects errors instead of throwing on invalid values", () => {
    clearConfigEnv();
    const { defaults, errors } = resolveConfigDefaults({
      MDR_PORT: "abc",
      MDR_HOST: "http://nope",
    });

    expect(defaults.port).toBeUndefined();
    expect(defaults.host).toBeUndefined();
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain("MDR_PORT");
    expect(errors[1]).toContain("MDR_HOST");
  });
});
