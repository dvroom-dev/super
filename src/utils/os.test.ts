import { describe, it, expect } from "bun:test";
import { defaultSupervisorHome } from "./os.js";
import os from "node:os";
import path from "node:path";

describe("defaultSupervisorHome", () => {
  it("returns path under home directory", () => {
    const home = defaultSupervisorHome();
    expect(home.startsWith(os.homedir())).toBe(true);
  });

  it("uses .ai-supervisor-studio folder", () => {
    const home = defaultSupervisorHome();
    expect(home).toBe(path.join(os.homedir(), ".ai-supervisor-studio"));
  });

  it("returns consistent path on multiple calls", () => {
    const home1 = defaultSupervisorHome();
    const home2 = defaultSupervisorHome();
    expect(home1).toBe(home2);
  });

  it("returns absolute path", () => {
    const home = defaultSupervisorHome();
    expect(path.isAbsolute(home)).toBe(true);
  });
});
