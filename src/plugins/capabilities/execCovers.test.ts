import { describe, expect, it } from "vitest";
import type { Capability } from "@keepdeck/plugin-api";
import { execCovers } from "./execCovers";

const exec = (...commands: string[]): Capability => ({ kind: "exec", commands });

describe("execCovers", () => {
  it("matches an exact command", () => {
    expect(execCovers([exec("git")], "git")).toBe(true);
  });

  it("matches by basename — a declared command covers an absolute path to it", () => {
    expect(execCovers([exec("git")], "/usr/bin/git")).toBe(true);
  });

  it("matches by basename across a backslash path", () => {
    expect(execCovers([exec("git")], "C:\\Program Files\\Git\\git.exe")).toBe(false);
    expect(execCovers([exec("git.exe")], "C:\\Program Files\\Git\\git.exe")).toBe(true);
  });

  it("does not match an unrelated command", () => {
    expect(execCovers([exec("git")], "curl")).toBe(false);
  });

  it("the wildcard covers anything", () => {
    expect(execCovers([exec("*")], "anything-at-all")).toBe(true);
  });

  it("requires the literal \"$SHELL\" entry to cover a shell spawn", () => {
    expect(execCovers([exec("git")], "$SHELL")).toBe(false);
    expect(execCovers([exec("$SHELL")], "$SHELL")).toBe(true);
  });

  it("ignores non-exec capabilities", () => {
    expect(execCovers([{ kind: "ports" }], "git")).toBe(false);
  });

  it("checks every exec capability entry, not just the first", () => {
    expect(execCovers([exec("git"), exec("curl")], "curl")).toBe(true);
  });

  it("an empty capability list covers nothing", () => {
    expect(execCovers([], "git")).toBe(false);
  });
});
