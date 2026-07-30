import { test, expect } from "vitest";
import {
  DEFAULT_PORT,
  MIN_PLUGIN_VERSION,
  isPluginVersionSupported,
  pluginVersionWarning,
  resolveRestConfig,
} from "./config.js";

// ============================================================================
// ENABLE / DISABLE
// ============================================================================

test("an empty environment disables REST", () => {
  expect(resolveRestConfig({})).toBeNull();
});

test("a blank api key disables REST", () => {
  expect(resolveRestConfig({ OBSIDIAN_API_KEY: "   " })).toBeNull();
});

test("an api key alone is enough to produce a config", () => {
  expect(resolveRestConfig({ OBSIDIAN_API_KEY: "k" })).toEqual({
    apiKey: "k",
    host: "127.0.0.1",
    port: 27123,
    protocol: "https",
    verifySsl: false,
  });
});

// ============================================================================
// THE PORT TRAP
// ============================================================================

test("the port default is 27123, not the 27124 the OpenAPI document implies", () => {
  // The plugin's shipped default for HTTPS is 27124, but the target vault runs
  // HTTPS on 27123 with the insecure server disabled. Defaulting to 27124 would
  // fail every connection and silently pin the server to filesystem fallback.
  expect(DEFAULT_PORT).toBe(27123);
  expect(resolveRestConfig({ OBSIDIAN_API_KEY: "k" })?.port).toBe(27123);
  expect(resolveRestConfig({ OBSIDIAN_API_KEY: "k" })?.port).not.toBe(27124);
});

test("an explicit port overrides the default", () => {
  expect(resolveRestConfig({ OBSIDIAN_API_KEY: "k", OBSIDIAN_PORT: "27124" })?.port).toBe(27124);
});

test.each(["abc", "27123.5", "0", "70000", "-1"])(
  "a malformed port (%s) throws rather than defaulting",
  (port) => {
    expect(() => resolveRestConfig({ OBSIDIAN_API_KEY: "k", OBSIDIAN_PORT: port })).toThrow(
      /Invalid OBSIDIAN_PORT/,
    );
  },
);

test("an empty port string falls back to the default", () => {
  expect(resolveRestConfig({ OBSIDIAN_API_KEY: "k", OBSIDIAN_PORT: "" })?.port).toBe(27123);
});

// ============================================================================
// OTHER OVERRIDES
// ============================================================================

test("host and protocol can be overridden", () => {
  const config = resolveRestConfig({
    OBSIDIAN_API_KEY: "k",
    OBSIDIAN_HOST: "localhost",
    OBSIDIAN_PROTOCOL: "http",
  });

  expect(config?.host).toBe("localhost");
  expect(config?.protocol).toBe("http");
});

test("an unknown protocol throws", () => {
  expect(() => resolveRestConfig({ OBSIDIAN_API_KEY: "k", OBSIDIAN_PROTOCOL: "ftp" })).toThrow(
    /Invalid OBSIDIAN_PROTOCOL/,
  );
});

test.each([
  ["true", true],
  ["TRUE", true],
  ["1", true],
  ["yes", true],
  ["false", false],
  ["0", false],
  ["no", false],
] as const)("OBSIDIAN_VERIFY_SSL=%s resolves to %s", (raw, expected) => {
  expect(resolveRestConfig({ OBSIDIAN_API_KEY: "k", OBSIDIAN_VERIFY_SSL: raw })?.verifySsl).toBe(
    expected,
  );
});

test("ssl verification defaults to off, because the plugin ships a self-signed cert", () => {
  expect(resolveRestConfig({ OBSIDIAN_API_KEY: "k" })?.verifySsl).toBe(false);
});

test("an unparseable OBSIDIAN_VERIFY_SSL throws", () => {
  expect(() => resolveRestConfig({ OBSIDIAN_API_KEY: "k", OBSIDIAN_VERIFY_SSL: "ture" })).toThrow(
    /Invalid OBSIDIAN_VERIFY_SSL/,
  );
});

test("surrounding whitespace is trimmed from every value", () => {
  expect(
    resolveRestConfig({
      OBSIDIAN_API_KEY: "  k  ",
      OBSIDIAN_HOST: " 10.0.0.2 ",
      OBSIDIAN_PORT: " 8080 ",
      OBSIDIAN_PROTOCOL: " HTTP ",
    }),
  ).toEqual({ apiKey: "k", host: "10.0.0.2", port: 8080, protocol: "http", verifySsl: false });
});

// ============================================================================
// PLUGIN VERSION FLOOR
// ============================================================================

test("the floor is the version verified against the live plugin", () => {
  expect(MIN_PLUGIN_VERSION).toBe("4.1.7");
});

test.each(["4.1.7", "4.1.8", "4.2.0", "5.0.0", "10.0.0"])("%s meets the floor", (version) => {
  expect(isPluginVersionSupported(version)).toBe(true);
  expect(pluginVersionWarning(version)).toBeNull();
});

test.each(["4.1.6", "4.0.0", "3.9.9", "0.1.0"])("%s is below the floor", (version) => {
  expect(isPluginVersionSupported(version)).toBe(false);
  expect(pluginVersionWarning(version)).toContain(MIN_PLUGIN_VERSION);
});

test("a pre-release suffix compares on its numeric part", () => {
  expect(isPluginVersionSupported("4.1.7-beta.1")).toBe(true);
  expect(isPluginVersionSupported("4.1.6-beta.1")).toBe(false);
});

test("an unknown version is treated as supported rather than blocking startup", () => {
  expect(isPluginVersionSupported(undefined)).toBe(true);
  expect(isPluginVersionSupported("")).toBe(true);
  expect(isPluginVersionSupported("unknown")).toBe(true);
});
