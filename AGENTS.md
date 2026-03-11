# Super Runtime: Local Agent Rules

## Mission

`super` is a standalone Bun/TypeScript runtime for supervised agent conversations driven by `super.yaml`.

Hard rules:
- Keep `super` independent. Do not reintroduce source-level dependencies on sibling repos such as `~/projs/agent-studio`.
- Preserve the run-config interface. `super.yaml` loading, rendering, and runtime behavior must stay fully compatible unless the user explicitly asks to change that contract.
- Favor one active implementation per behavior. Do not add compatibility shims for dead code paths without a proven active consumer.
- Fail loudly for broken benchmark-critical behavior. Do not silently skip config parsing, prompt assembly, store writes, provider events, or supervisor decisions.

## Repo Map

Start from the live entrypoints and work outward:

- CLI entrypoint: `src/bin/super.ts`
- Local state/session helpers: `src/lib/**`
- Run-config loading/rendering: `src/supervisor/run_config*.ts`
- Prompt compilation and supervisor logic: `src/supervisor/**`
- Provider integrations: `src/providers/**`
- Conversation runtime and supervise loop: `src/server/stdio/**`
- Transcript parsing/rendering: `src/markdown/**`
- Fork persistence: `src/store/**`
- Tool definitions/execution: `src/tools/**`

When changing behavior, inspect the actual call path instead of inferring ownership from filenames.

## Architecture Expectations

`super` is now the source of truth for its own runtime. Treat these as invariants:

- No imports from `agent-studio` or other sibling repos.
- Workspace-local conversation state remains canonical.
- Session markdown plus frontmatter remain the user-visible source of truth.
- Provider raw events, transcript updates, and fork storage must stay diagnosable.
- Supervisor and agent behavior should be driven by run config and prompt assets, not hidden code-side policy text.

If you suspect a regression in independence, verify it directly with:

```bash
rg -n "agent-studio" .
```

That check should return no matches in this repo.

## Validation Process

Run validations from `~/projs/super`.

Required checks for normal code changes:

```bash
bun run lint
bun run typecheck
bun run test
```

Convenience wrapper:

```bash
bun run validate
```

What each check means:

- `bun run lint`: enforces repository lint rules, including the non-test `.ts` file size cap of 1000 lines.
- `bun run typecheck`: must pass with no TypeScript errors.
- `bun run test`: must pass before committing code changes.

For changes that affect CLI/runtime behavior, also run a smoke test that exercises:

- `super new`
- `super status`
- `super resume`

Use a temporary workspace and a mock provider unless the task specifically requires a real provider.

## Commit Process

Validated changes must not sit uncommitted.

Hard rules:

- Once the relevant validation passes for a scoped change, commit it in the same pass.
- Prefer granular commits. Separate independent validated changes instead of batching them.
- Do not fold unrelated edits into the same commit just because they are nearby.
- If a later change depends on an earlier validated change, commit the earlier step first, then continue.

Examples of good commit boundaries:

- lint/tooling enforcement
- runtime bug fix
- config compatibility fix
- test additions for a specific behavior
- documentation/process updates

## Review Priorities

When reviewing or debugging, focus on behavior and risk first:

- run-config compatibility regressions
- supervisor decision drift
- provider event handling and resume continuity
- transcript/fork persistence correctness
- hidden fallbacks or swallowed failures
- observability gaps that make runtime failures hard to diagnose
- accidental reintroduction of sibling-repo dependencies

If you claim a runtime cause, cite the exact file, test, artifact, or log line that proves it.

## Practical Rules

- Prefer `rg` and `rg --files` for searches.
- Keep non-test `.ts` files under 1000 lines. Split modules before they become oversized.
- Keep tests close to the behavior they verify.
- Do not commit local artifacts such as `node_modules`.
- If an interface changes, update the active runtime path and its tests in the same pass.

## Default Workflow

1. Inspect the live code path you are about to change.
2. Make the smallest coherent change that fixes the problem.
3. Run `bun run lint`, `bun run typecheck`, and `bun run test`.
4. If runtime behavior changed, run the CLI smoke test too.
5. Commit that validated change before moving on to the next one.
