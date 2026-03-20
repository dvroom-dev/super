# V2 Design Sketch

## Overview

V2 replaces the current "mode state machine as workflow" design with:

1. a supervisor-owned process ledger;
2. a process spec with stage requirements and validators;
3. task profiles that replace modes as the main execution abstraction;
4. short-lived worker conversations by default;
5. supervisor-owned context assembly and model selection;
6. explicit validation loops after worker turns.

The intent is to keep the flexibility of agentic work while moving workflow
authority and progression logic into the supervisor.

## Main Concepts

### 1. Process Ledger

The supervisor maintains a machine-readable ledger for the run. This ledger is
the authoritative process state and should be the primary input to context
assembly for workers.

Suggested ledger sections:

- `run`
  - game ids, frontier level, solved levels, active process stage
- `features`
  - detected features by level, definitions, evidence, confidence, purpose
- `hypotheses`
  - currently active hypotheses, supporting evidence, contradictions
- `action_vocabulary`
  - action meanings and confidence
- `model_state`
  - model mechanics status, compare status, exact blockers
- `solution_state`
  - branch candidates, proof status, real-game replay status
- `blockers`
  - exact currently blocking contradictions or evidence gaps
- `artifacts`
  - canonical references to compare/model/coverage/state artifacts

This ledger should be written to disk in a stable place and updated only by the
supervisor or through validated worker outputs.

### 2. Task Profiles

Task profiles replace "modes as workflow stages."

Profiles describe how to run a task, not what the whole workflow is.

Examples:

- `action-vocabulary`
- `spatial-analysis`
- `mechanic-probing`
- `model-repair`
- `solution-synthesis`
- `recovery`
- `wrapup-certification`

Each profile defines:

- preferred models;
- tool allowlist;
- context recipe;
- output schema;
- validator loop;
- failure escalation behavior;
- whether to reuse or fork conversations by default.

### 3. Process Spec

The process spec expresses progression requirements and conditionals directly.

Instead of:

- `theory -> explore_only -> code_model -> solve_model`

we want:

- objective;
- prerequisites;
- required evidence;
- forbidden conclusions;
- validator requirements;
- escalation rules;
- next-stage routing conditions.

### 4. Supervisor-Owned Context Assembly

The supervisor should assemble worker context directly from:

- the process ledger;
- selected artifact slices;
- recent validated evidence;
- current task packet;
- task profile rules.

Workers should not be trusted to implicitly reconstruct process state from a
long transcript alone.

### 5. Worker Task Packets

Each worker invocation should receive a bounded task packet.

Suggested packet fields:

- `task_id`
- `profile`
- `objective`
- `success_definition`
- `forbidden_moves`
- `required_artifacts`
- `required_output_schema`
- `validator_plan`
- `handoff_evidence`
- `resume_policy`

### 6. Validation Loops

A validation loop is a first-class orchestration primitive:

1. spawn/resume worker;
2. worker produces output/artifact patch;
3. supervisor runs validator commands;
4. if validator fails, the supervisor decides:
   - retry same worker with validator output;
   - fork a new worker with fresh context;
   - escalate to another profile/model;
   - block progression.

This is especially important for:

- feature coverage;
- compare parity;
- solution replay;
- wrap-up certification.

## What Changes Relative To Today

### Modes Become Profiles

Current modes still provide value, but they should be reframed.

For example:

- current `theory` becomes mostly `spatial-analysis` and `mechanic-probing`;
- current `code_model` becomes `model-repair`;
- current `solve_model` becomes `solution-synthesis` plus replay validation;
- current `recover` remains a distinct recovery profile.

The supervisor can still expose a "mode-like" label for observability, but the
process should no longer be driven by mode-transition edges alone.

### `switch_mode` Becomes Less Central

In V2, the main worker tool should not be "switch_mode and decide the next
stage." The supervisor should decide progression after evaluating:

- worker output;
- validator results;
- ledger state;
- process rules.

Workers can still request escalation or suggest the next profile, but they
should not unilaterally drive progression.

### More Fresh Conversations

The default should shift toward short-lived or task-scoped conversations.

Reuse is still useful for:

- bounded iterative parity repair;
- incremental recovery;
- local follow-up on a validator failure.

But fresh forks should be the default for:

- feature analysis;
- contradiction review;
- independent solution critique;
- model proof review;
- any task whose predecessor may have contaminated assumptions.

## Hard Evidence Rules V2 Should Enforce

These rules are specifically motivated by recent failures.

### Rule 1: New Frontier Feature Gate

A newly introduced component on a frontier level cannot be ruled out as
decorative or non-gating without action-linked evidence on that level.

### Rule 2: New Color/Value Gate

A new color or grid value introduced on a frontier level is a mandatory
investigation target until proven otherwise.

### Rule 3: Inherited Schema Guard

A completion schema inherited from earlier levels cannot become the leading
frontier theory until new deltas are either incorporated or explicitly ruled out
with evidence.

### Rule 4: Contradiction Reopen

Any real-game contradiction against a previously "resolved" mechanic reopens the
mechanic automatically.

### Rule 5: Compare Scope Guard

Compare-clean validates explored real-game sequences only. It never proves:

- unseen branch suffixes;
- newly introduced mechanics;
- new completion conditions;
- real-game readiness of a model-only branch.

### Rule 6: Model-Proof Scope Guard

Model proof is a hypothesis check. It does not certify a branch whose mechanics
have not been grounded in real-game evidence.

## Model Selection

V2 should allow the supervisor to choose models per task.

Suggested pattern:

- fast/cheap models for coverage checks, artifact summarization, and constrained
  extraction tasks;
- stronger reasoning models for contradiction resolution and frontier-mechanic
  synthesis;
- code-oriented models for parity and branch authoring;
- optional second-opinion workers for critique tasks.

This should be policy-driven from config, not hardcoded in runtime logic.

## Multi-Agent Orchestration

Multiple agents are useful, but only for independent bounded tasks.

Good uses:

- one worker enumerates new features;
- one worker critiques whether any new feature was improperly ruled out;
- one worker diagnoses compare divergence;
- one worker proposes a model patch;
- the supervisor chooses among them.

Bad uses:

- multiple workers mutating the same theory artifact without arbitration;
- parallel speculative workers on the same ambiguous question with no structured
  synthesis step.

Recommended pattern:

- parallel for independent evidence gathering;
- serial for decision and integration.

## State Visibility And Pinning

The current level/state pinning bugs suggest that hidden runtime state is too
implicit.

V2 should not rely on magical pinning behavior. Instead:

- process state should say what level is the current analysis target;
- visible state surfaces should be derived from explicit supervisor policy;
- compare surfaces should be declared and versioned;
- wrap-up certification should be explicit process state, not an inferred side
  effect of mode changes.

This may still look like "pinning" semantically, but it should be explicit and
observable.

## Example Of How V2 Would Handle A Frontier Level

For a new level:

1. `action-vocabulary` packet:
   establish the smallest action semantics needed to identify controllable
   behavior.

2. `spatial-analysis` packet:
   enumerate all visible components and verify coverage.

3. `mechanic-probing` packet:
   require at least one discriminating probe for each new frontier delta.

4. `model-repair` packet:
   implement only mechanics with evidence-backed status.

5. `solution-synthesis` packet:
   produce a candidate branch from proven or explicitly marked speculative
   mechanics.

6. `validator loop`:
   run compare, component coverage, model proof, or replay validator as needed.

7. On contradiction:
   reopen the violated hypothesis and route to the right next packet.

## Migration Advice

A full rewrite is not required on day one.

Recommended incremental path:

1. add a process ledger;
2. add task profiles;
3. add validator loops;
4. move progression authority into the supervisor;
5. make worker conversations shorter-lived by default;
6. replace the mode state machine with the process spec once the new primitives
   exist.
