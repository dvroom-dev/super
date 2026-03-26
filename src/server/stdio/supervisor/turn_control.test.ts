import { describe, expect, it } from "bun:test";
import { decideSupervisorTurn } from "./turn_control.js";

describe("decideSupervisorTurn", () => {
  it("schedules hard review on natural stream end", () => {
    const decision = decideSupervisorTurn({
      supervisorEnabled: true,
      reasons: [],
      cadenceHit: false,
      streamEnded: true,
      hadError: false,
      interrupted: false,
    });
    expect(decision.supervisorMode).toBe("hard");
  });

  it("uses hard mode for hard stop reasons", () => {
    const decision = decideSupervisorTurn({
      supervisorEnabled: true,
      reasons: ["time_budget"],
      cadenceHit: false,
      streamEnded: false,
      hadError: false,
      interrupted: false,
    });
    expect(decision.supervisorMode).toBe("hard");
  });

  it("does not force hard review for nonterminal shell-policy interruptions when no hard stop reasons exist", () => {
    const decision = decideSupervisorTurn({
      supervisorEnabled: true,
      reasons: [],
      cadenceHit: false,
      streamEnded: false,
      hadError: false,
      interrupted: true,
    });
    expect(decision.supervisorMode).toBeNull();
  });

  it("uses soft mode for cadence checkpoints", () => {
    const decision = decideSupervisorTurn({
      supervisorEnabled: true,
      reasons: [],
      cadenceHit: true,
      streamEnded: false,
      hadError: false,
      interrupted: false,
    });
    expect(decision.supervisorMode).toBe("soft");
  });

  it("does not schedule review when supervisor is disabled", () => {
    const decision = decideSupervisorTurn({
      supervisorEnabled: false,
      reasons: [],
      cadenceHit: false,
      streamEnded: true,
      hadError: false,
      interrupted: false,
    });
    expect(decision.supervisorMode).toBeNull();
  });

  it("does not schedule review when stream has not ended and no cadence/hard reason exists", () => {
    const decision = decideSupervisorTurn({
      supervisorEnabled: true,
      reasons: [],
      cadenceHit: false,
      streamEnded: false,
      hadError: false,
      interrupted: false,
    });
    expect(decision.supervisorMode).toBeNull();
  });
});
