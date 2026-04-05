# Super Flux Redesign Plan

## Purpose

This document defines a fresh flux runtime implementation for `~/projs/super`.

The current runtime should be treated as disposable. Backward compatibility is not a goal. The new implementation should favor:

- immutable inputs
- event-sourced state
- typed decisions
- reproducibility from fixtures
- explicit race handling
- deletion of mutable side-file coordination

This plan assumes a paired harness redesign in:

- [harness plan](/home/dvroom/projs/arc-agi-harness/ctx/flux-functional-redesign-20260405/HARNESS_PLAN.md)

## Design Rules

### 1. Commands carry full causal input

No worker should recover its real input from mutable files like:

- `flux/model/current/trigger.json`
- `flux/seed/current_trigger.json`
- `flux/seed/current_launch.json`

Those files should be deleted.

### 2. Events are canonical, files are materialized views

`flux/state.json` should become a projection of an append-only event log, not the source of truth.

### 3. Model and seed revisions are first-class ids

Every meaningful worker output must create or reference a typed revision id:

- `model_revision_id`
- `seed_revision_id`
- `evidence_bundle_id`
- `rehearsal_result_id`
- `replay_result_id`

### 4. Worker sessions are not the same thing as worker inputs

Modeler and bootstrapper may reuse provider threads, but each invocation must still have an explicit immutable command object.

## Replacement Architecture

## A. Event log

Create a new event log under `flux/events/`:

- `events.ndjson`

Every orchestrator action appends one event. Examples:

- `SolverInvocationQueued`
- `SolverInvocationStarted`
- `SolverEvidencePublished`
- `ModelInvocationQueued`
- `ModelInvocationStarted`
- `ModelRevisionAccepted`
- `SeedInvocationQueued`
- `SeedInvocationStarted`
- `SeedRevisionProposed`
- `SeedRehearsalCompleted`
- `SeedReplayCompleted`
- `SeedRevisionAttested`
- `SolverInterruptionRequested`
- `InvocationFailed`

Add a pure reducer:

- `reduceFluxState(previousState, event) -> nextState`

Project `flux/state.json` from that reducer only.

## B. Real command queue

Replace the current queue implementation in [queue.ts](/home/dvroom/projs/super/src/flux/queue.ts#L37).

Current behavior:

- stores one item only
- strips payload

New behavior:

- append immutable command records
- preserve payload
- include:
  - `command_id`
  - `command_type`
  - `created_at`
  - `causation_id`
  - `supersedes`
  - `priority`
  - `payload`

Queue types:

- `solver_invocation`
- `model_invocation`
- `bootstrapper_invocation`

Each command payload must be self-sufficient.

## C. Invocation model

### Solver invocation

Payload:

- `seed_revision_id | null`
- `interrupt_policy`
- `reason`

Behavior:

- always creates a fresh attempt
- never mutates an existing attempt

### Model invocation

Payload:

- `baseline_model_revision_id`
- `target_evidence_bundle_id`
- `reason`

Behavior:

- provider thread may be reused
- compare target is fixed for the invocation
- if newer evidence appears, emit a newer command after completion

### Bootstrapper invocation

Payload:

- `baseline_model_revision_id`
- `previous_seed_revision_id | null`
- `reason`

Behavior:

- provider thread may be reused
- must not switch to a newer model revision mid-run

## D. Versioned model improvement logic

The runtime needs a precise answer to "did the model improve enough to wake bootstrapper?"

Add a typed `ModelCoverageSummary` stored per accepted model revision:

- `covered_sequence_ids`
- `max_contiguous_sequence_prefix_by_level`
- `frontier_level`
- `frontier_status`
- `accepted_compare_kind`

Bootstrapper baseline is the last model revision that bootstrapper used successfully.

Improvement rules:

- improvement if a new model covers any sequence the bootstrapper baseline could not cover
- improvement if it advances contiguous coverage on the same level
- improvement if it advances the frontier level
- no improvement if acceptance is equivalent to the baseline

Emit:

- `model_improvement_kind`
- `improvement_against_model_revision_id`

## E. Seed delta and interruption policy

Bootstrapper must not blindly interrupt the solver when a seed changes.

After a seed proposal, classify delta against the currently active seed:

- `no_useful_change`
- `mechanic_explanation_added`
- `mechanic_explanation_improved`
- `level_completion_advanced`
- `frontier_branch_improved`

Then map to solver policy:

- `no_action`
- `queue_without_interrupt`
- `queue_and_interrupt`

Rules:

- `queue_and_interrupt`
  - new mechanic not explained before
  - materially improved explanation
  - new seed completes a level old seed did not complete
- `queue_without_interrupt`
  - real improvement but marginal
- `no_action`
  - equivalent or useless change

This should be decided by code from typed seed metadata, not left to ambiguous prose.

## F. Concurrency and race guards

### Solver vs solver replacement

Keep one active solver invocation.

When a newer solver command appears:

- if policy is `no_action`, drop it
- if policy is `queue_without_interrupt`, leave active solver running and mark replacement pending
- if policy is `queue_and_interrupt`, request interruption only if:
  - the replacement seed revision is newer
  - delta classification is interrupt-worthy

### Solver vs modeler

Modeler should run when new evidence exceeds current model coverage.

Guard:

- one active model invocation at a time
- current model invocation has a fixed `target_evidence_bundle_id`
- newer evidence arriving during model execution only queues a follow-up command if it exceeds the invocation target

Do not let the invocation compare against a newer bundle than it started with.

### Modeler vs bootstrapper

Bootstrapper input binds to `baseline_model_revision_id`.

If a newer model revision is accepted while bootstrapper is running:

- do not mutate current bootstrapper inputs
- queue a newer bootstrapper command after completion if the new model is an improvement relative to bootstrapper baseline

### Projection races

Projections must be rebuildable.

Approach:

- append event
- update derived queue/state/session projections from reducer
- if projection write fails, rebuild from event log

Do not store meaning only in projections.

## G. Session reuse semantics

Session reuse is allowed only at the provider-thread layer.

The runtime model should distinguish:

- `session_id`
- `invocation_id`

One `modeler_run` session may process many invocation ids. Same for bootstrapper.

All stored messages and prompt payloads must reference:

- `session_id`
- `invocation_id`
- `input_bundle_ids`

Without that, later debugging cannot answer "which exact inputs produced this response?"

## H. File layout

New runtime storage:

- `flux/events/events.ndjson`
- `flux/projections/state.json`
- `flux/projections/queues/*.json`
- `flux/projections/current_heads.json`
- `.ai-flux/sessions/<worker>/<session_id>/...`
- `flux/model_revisions/<model_revision_id>/...`
- `flux/seed_revisions/<seed_revision_id>/...`
- `flux/invocations/<invocation_id>/input.json`
- `flux/invocations/<invocation_id>/result.json`

Delete:

- `flux/model/current/*`
- `flux/seed/current_trigger.json`
- `flux/seed/current_launch.json`
- the current queue files as semantic sources of truth

## Runtime Modules To Replace

Replace or rewrite from scratch:

- [orchestrator.ts](/home/dvroom/projs/super/src/flux/orchestrator.ts)
- [queue.ts](/home/dvroom/projs/super/src/flux/queue.ts)
- [solver_runtime.ts](/home/dvroom/projs/super/src/flux/solver_runtime.ts)
- [modeler_runtime.ts](/home/dvroom/projs/super/src/flux/modeler_runtime.ts)
- [bootstrapper_runtime.ts](/home/dvroom/projs/super/src/flux/bootstrapper_runtime.ts)
- [state.ts](/home/dvroom/projs/super/src/flux/state.ts)

Keep and adapt:

- provider wrapper shape in [provider_session.ts](/home/dvroom/projs/super/src/flux/provider_session.ts)
- event append utilities
- session storage helpers

## Testing Plan

### 1. Reducer tests

Build most logic around pure reducers/selectors and test them directly.

Critical selectors:

- `should_queue_modeler`
- `should_queue_bootstrapper`
- `classify_model_improvement`
- `classify_seed_delta`
- `choose_solver_replacement_policy`
- `should_interrupt_active_solver`

### 2. Command-log scenario tests

Construct full scenarios by feeding commands and worker results into the event loop with mock workers.

Important scenarios:

- new evidence arrives while modeler is running
- newer evidence arrives twice before modeler finishes
- bootstrapper starts on model revision N while revision N+1 is accepted mid-run
- seed delta is marginal, so replacement solver queues without interruption
- seed delta is strong, so replacement solver interrupts
- equivalent seed revision produces no action

### 3. Projection rebuild tests

Kill and rebuild from `events.ndjson`.

Assert the rebuilt state matches the live projection.

### 4. Recorded-fixture e2e tests

Use harness replay packs instead of fake one-line observe/accept scripts.

The runtime test should consume:

- evidence bundle fixtures
- compare result fixtures
- rehearsal result fixtures
- replay result fixtures

No live provider required.

### 5. Negative tests

Add explicit tests for:

- missing artifacts
- contradictory compare payloads
- acceptance against stale bundle ids
- bootstrapper trying to finalize after incomplete rehearsal
- stale invocation results arriving after newer superseding results

## Work Stages

### Stage 1: Functional core

- event types
- reducer
- selectors
- command types
- revision metadata types

### Stage 2: New orchestrator

- command queue
- invocation lifecycle
- projection rebuild
- race guards

### Stage 3: Worker rewrites

- solver worker bound to seed revision
- modeler worker bound to model revision + evidence bundle
- bootstrapper worker bound to model revision baseline

### Stage 4: End-to-end fixture tests

- integrate recorded harness fixtures
- verify interruption policy and improvement logic

### Stage 5: Delete old runtime

- remove side-file trigger design
- remove payload-stripping queue
- remove implicit latest-state acceptance logic

## Non-Negotiable Invariants

- one invocation has one immutable input payload
- one acceptance result references one model revision and one evidence bundle
- one bootstrapper invocation is bound to one baseline model revision
- no solver interruption without explicit typed policy
- no semantic data lives only in mutable side files
- full orchestration can be tested without running real LLMs
