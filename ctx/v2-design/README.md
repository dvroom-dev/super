# Supervisor V2 Design Notes

This directory records the motivations, goals, and an initial concrete design
sketch for a more supervisor-centric `super` / harness architecture.

Files:

- `motivations-and-goals.md`
  Why the current design is failing, what must improve, and the high-level
  principles of a redesign.
- `v2-design-sketch.md`
  A concrete architecture proposal for a process-ledger-driven supervisor,
  short-lived task workers, stronger validators, and model/profile selection.
- `proposed-super-yaml-schema.md`
  A draft schema for a future `super.yaml` that expresses tools, models, task
  profiles, process stages, validators, and orchestration policy directly.
- `example-super-v2.yaml`
  A worked example config showing how the proposed schema could express the ARC
  harness workflow and the supervisor behavior discussed in recent debugging.

Status:

- These documents are design notes, not an implemented runtime contract.
- The schema is intentionally opinionated and should be treated as a draft for
  iteration, not as a migration plan locked to current code.
