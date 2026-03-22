# Explicit Level State

## Principle

V2 should not infer task level from hidden runtime state such as pins, current visible workspace level, or compare cleanliness.

The supervisor owns level scope explicitly through `transition_payload`.

Required fields on schema-version-2 routing decisions:

- `analysis_scope`
- `analysis_level`
- `frontier_level`

Recommended meanings:

- `analysis_scope=frontier`
  - normal work on the live current level
  - `analysis_level == frontier_level`
- `analysis_scope=wrapup`
  - post-completion accounting on a solved level while the live game has already advanced
  - `analysis_level < frontier_level`

## Workspace Contract

- `level_current/`
  - always represents the live frontier-visible level
- `analysis_state.json`
  - authoritative explicit task-level contract for the current worker
- `analysis_level/`
  - materialized only when `analysis_level != frontier_level`
  - contains the explicit non-frontier analysis surface
- `current_compare.*`
  - compare surface for `analysis_level`, not implicitly for `level_current`

This means visible world state and active compare target can differ, but only when the supervisor says so explicitly.

## Worker Contract

Workers must not guess level scope from:

- visible `level_current/`
- whether a compare file is clean or red
- historical assumptions about solved-level wrap-up

Workers should:

1. read `analysis_state.json`
2. treat `analysis_level` as the target for compare/model/coverage work
3. use explicit `--level <analysis_level>` arguments whenever the task is not on the frontier
4. use `analysis_level/` rather than `level_current/` when inspecting non-frontier solved-level artifacts

## Harness Contract

The harness should:

- mirror the frontier level into `level_current/`
- mirror the explicit non-frontier analysis level into `analysis_level/` when requested
- never block progression based on hidden certification rules
- never silently retarget compare/model work to a different level

The harness may validate surface consistency, but it must not decide whether wrap-up is complete. That decision belongs to the supervisor.
