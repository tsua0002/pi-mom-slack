import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { configFromEnv, configsFromEnv } from "../src/config.ts";

const base = { SLACK_APP_TOKEN: "xapp-base", SLACK_BOT_TOKEN: "xoxb-base", PI_SLACK_ALLOWED_USERS: "U1", PI_SLACK_DATA_DIR: "./state" };
const profiles = { PI_SLACK_WORKSPACES: "demo,other", SLACK_APP_TOKEN_DEMO: "xapp-demo", SLACK_BOT_TOKEN_DEMO: "xoxb-demo", SLACK_APP_TOKEN_OTHER: "xapp-other", SLACK_BOT_TOKEN_OTHER: "xoxb-other", PI_SLACK_ALLOWED_USERS: "U1", PI_SLACK_DATA_DIR: "./state" };

describe("configsFromEnv", () => {
 it("preserves the single config and data directory", () => {
  expect(configsFromEnv(base)).toEqual([configFromEnv(base)]);
 });
 it("supports named-only profiles, fallback users and explicit wildcard", () => {
  const configs = configsFromEnv({ ...profiles, PI_SLACK_ALLOWED_USERS_OTHER: "*" }, ["CUSTOM_SECRET"]);
  expect(configs.map(c => c.dataDir)).toEqual([resolve("state/workspaces/demo"), resolve("state/workspaces/other")]);
  expect(configs.map(c => c.allowedUsers)).toEqual([["U1"], ["*"]]);
  expect(configs.every(c => c.secretNames.includes("CUSTOM_SECRET"))).toBe(true);
 });
 it("includes the base bot without moving its data", () => {
  const configs = configsFromEnv({ ...profiles, ...base });
  expect(configs).toHaveLength(3);
  expect(configs[0]).toEqual(configFromEnv(base));
 });
 it.each(["../demo", "/tmp", ".", "demo/other", "demo,demo", "demo,DEMO", "a-b,a_b"])("rejects unsafe or ambiguous names: %s", (name) => {
  expect(() => configsFromEnv({ ...profiles, PI_SLACK_WORKSPACES: name })).toThrow();
 });
 it("requires complete token pairs and users", () => {
  expect(() => configsFromEnv({ ...profiles, SLACK_BOT_TOKEN_DEMO: undefined })).toThrow("SLACK_BOT_TOKEN_DEMO");
  expect(() => configsFromEnv({ ...profiles, PI_SLACK_ALLOWED_USERS: undefined })).toThrow("PI_SLACK_ALLOWED_USERS_DEMO");
  expect(() => configsFromEnv({ ...profiles, PI_SLACK_ALLOWED_USERS_DEMO: "" })).toThrow("PI_SLACK_ALLOWED_USERS_DEMO");
  expect(() => configsFromEnv({ ...profiles, SLACK_APP_TOKEN: "xapp-base" })).toThrow("SLACK_BOT_TOKEN");
  expect(() => configsFromEnv({})).toThrow("PI_SLACK_ALLOWED_USERS");
 });
 it("rejects repeated app tokens without exposing them", () => {
  try {
   configsFromEnv({ ...profiles, SLACK_APP_TOKEN_OTHER: profiles.SLACK_APP_TOKEN_DEMO });
   expect.fail("must reject duplicate tokens");
  } catch (error) {
   expect(String(error)).toContain("separate Slack app");
   expect(String(error)).not.toContain("xapp-demo");
  }
  expect(() => configsFromEnv({ ...profiles, ...base, SLACK_APP_TOKEN_DEMO: base.SLACK_APP_TOKEN })).toThrow("separate Slack app");
 });
});
