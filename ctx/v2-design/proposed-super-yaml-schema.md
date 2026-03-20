# Proposed `super.yaml` V2 Schema

This is a design sketch for a future schema. It is not a current runtime
contract.

## Top-Level Shape

```yaml
schema_version: 2

runtime_defaults:
  supervisor_provider: string
  supervisor_model: string
  default_worker_profile: string
  conversation_strategy: enum

models:
  <model_key>:
    provider: string
    model: string
    reasoning_effort: string
    strengths: [string]
    weaknesses: [string]
    relative_cost: enum
    max_parallelism: number

tools:
  <tool_key>:
    kind: enum
    description: string
    command: string | [string]
    examples: [string]
    parse_as: enum
    mutates_state: boolean
    categories: [string]

validators:
  <validator_key>:
    description: string
    run:
      command: string | [string]
      cwd_scope: enum
    parse:
      mode: enum
    pass_when: string
    failure_summary: string

task_profiles:
  <profile_key>:
    description: string
    preferred_models: [string]
    tools:
      allow: [string]
    context:
      recipe: [context_part]
    worker_contract:
      output_schema: object
      forbidden_conclusions: [string]
      required_citations: [string]
    validation_loop:
      after_turn: [string]
      on_failure: object
      on_success: object

process:
  global_rules: [string]
  ledger:
    path: string
    required_sections: [string]
  stages:
    - id: string
      description: string
      objective: string
      prerequisites: [string]
      required_evidence: [string]
      forbidden_progress_without: [string]
      completion_requirements: [string]
      default_profile: string
      candidate_profiles: [string]
      validators: [string]
      next:
        on_success: [string]
        on_failure: [string]
        on_blocked: [string]

orchestration:
  supervisor_owns_context: boolean
  short_lived_workers_by_default: boolean
  allow_parallel_workers: boolean
  parallelism_rules: [string]
  reuse_rules: [string]
  fresh_fork_rules: [string]
  model_selection_policy: [string]

artifact_policies:
  canonical_surfaces:
    process_ledger: string
    current_compare: string
    component_coverage: string
    model_status: string
    live_state: string
  visibility_rules: [string]
  state_contract_rules: [string]
```

## Key Sections

### `runtime_defaults`

Defines the default supervisor runtime and broad orchestration defaults.

Suggested fields:

- `supervisor_provider`
- `supervisor_model`
- `default_worker_profile`
- `conversation_strategy`
  - `short_lived`
  - `reuse_when_validator_requires`
  - `mixed`

### `models`

Defines available model choices and their intended role.

This allows the supervisor to choose models by task, not just by static mode.

Suggested fields:

- `provider`
- `model`
- `reasoning_effort`
- `strengths`
- `weaknesses`
- `relative_cost`
- `max_parallelism`

### `tools`

Defines the command-line toolbox available to the supervisor and workers.

Suggested fields:

- `kind`
  - `shell`
  - `builtin`
  - `validator`
  - `artifact_reader`
- `command`
- `description`
- `examples`
- `parse_as`
  - `text`
  - `json`
  - `markdown`
  - `none`
- `mutates_state`
- `categories`

### `validators`

Defines commands the supervisor may run after a worker turn.

Suggested fields:

- `description`
- `run.command`
- `run.cwd_scope`
- `parse.mode`
- `pass_when`
- `failure_summary`

Validators are the mechanism that turns "agent claimed success" into "system
observed success."

### `task_profiles`

Profiles are the main execution abstraction in V2.

They define:

- which models are preferred;
- which tools are allowed;
- how context is assembled;
- what outputs are required;
- what validators run after the turn;
- how to recover from validator failure.

### `process`

This replaces the mode transition graph as the main workflow definition.

Each stage should define:

- objective;
- prerequisites;
- required evidence;
- what is forbidden without stronger evidence;
- completion requirements;
- default task profile;
- validators;
- next-stage routing.

### `orchestration`

Defines how the supervisor is allowed to orchestrate workers.

Suggested concerns:

- when fresh forks are preferred;
- when thread reuse is acceptable;
- when parallel workers are allowed;
- whether second-opinion workers are allowed;
- how model selection is made.

### `artifact_policies`

Defines the canonical artifact surfaces and state contract rules.

This is where V2 should make state visibility explicit instead of relying on
implicit pinning behavior.

## Suggested Built-In Process Rules

These could live under `process.global_rules`.

- A newly introduced frontier-level component cannot be ruled out as non-gating
  without action-linked evidence on that level.
- A newly introduced frontier-level color or value is a mandatory investigation
  target until proven decorative.
- Compare-clean only validates explored real-game sequences; it never proves
  unseen suffixes or new mechanics.
- Model proof is a hypothesis check, not real-game certification of unseen
  mechanics.
- Any real-game contradiction against a resolved mechanic automatically reopens
  that mechanic.
- A prior-level completion schema cannot become the leading frontier theory
  until all new frontier deltas are incorporated or ruled out with evidence.

## Suggested Worker Output Contract Shape

```yaml
worker_contract:
  output_schema:
    type: object
    required:
      - outcome
      - evidence_updates
      - artifact_updates
      - blockers
    properties:
      outcome:
        type: string
      evidence_updates:
        type: array
      artifact_updates:
        type: array
      blockers:
        type: array
  forbidden_conclusions:
    - "Do not rule out a new frontier feature without action-linked evidence."
    - "Do not treat model-only success as proof of a new mechanic."
```

## Suggested Validation Loop Shape

```yaml
validation_loop:
  after_turn:
    - component_coverage
    - current_compare
  on_failure:
    resume_strategy: fork_fresh
    inject_validator_output_as: user_message
    escalation_profiles:
      - model-repair
      - contradiction-review
  on_success:
    update_ledger: true
    allow_progression_review: true
```

## Summary

The schema should let the supervisor control:

- models;
- task types;
- context assembly;
- tool availability;
- validator loops;
- progression requirements;
- artifact/state policy.

That is the minimum shape needed to move workflow authority out of long-running
worker conversations and into an explicit process controller.
