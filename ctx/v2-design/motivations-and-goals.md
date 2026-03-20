# Motivations And Goals

## Why This Exists

Recent ARC runs showed a class of failure that is not well explained by
"prompt quality" alone. The current system can visibly detect a new level
feature, acknowledge that it lacks action-linked evidence for that feature, and
then still reason past it and commit to an inherited prior-level schema.

That is not a local agent mistake only. It is a control-system failure.

The supervisor and runtime currently allow this pattern:

1. the agent makes a weak inference;
2. the supervisor accepts it because it fits the current mode contract;
3. the inference gets baked into `theory.md`, `model_lib.py`, `play_lib.py`,
   and later handoffs;
4. the system compounds the mistake rather than reopening the question.

This is especially dangerous on frontier levels where:

- a new component appears;
- a known component changes color or structure;
- a new value enters the grid;
- the completion rule diverges from prior levels.

## Core Problems In The Current Design

### 1. Modes Are Too Coarse

The current mode state machine is useful for basic organization, but it is too
coarse to encode the actual epistemic requirements of the task.

`theory`, `explore_only`, `code_model`, and `solve_model` do not say:

- what evidence is required to progress;
- what conclusions are forbidden without evidence;
- what validator must pass;
- what contradictions automatically reopen a question.

### 2. The Agent Has Too Much Workflow Authority

The agent effectively decides when a question is "resolved" and when a mode
transition is justified. That is too much control when the agent is also the
thing doing the local reasoning that may be wrong.

### 3. Long-Running Conversations Preserve Bad State

Once a bad abstraction enters a long-lived thread, it contaminates later work.
The current system relies heavily on resuming the same task/mode conversations,
which preserves helpful context but also preserves wrong frames.

### 4. Validation Is Too Weakly Coupled To Claims

The current control flow allows statements like:

- "resolved"
- "ruled out"
- "ready for solve replay"
- "model proof passed"

without always requiring the right kind of evidence.

Examples of missing evidence gates:

- a newly introduced component ruled out without action-linked evidence;
- compare-clean on explored sequences treated as proof of new mechanic semantics;
- model-only success treated as real-game readiness for unseen branch suffixes.

### 5. Hidden Runtime State Is Too Magical

Pinned levels, visible state, frontier state, compare surfaces, reset semantics,
and solved-level wrap-up all rely on subtle runtime/artifact behavior.

This makes failures hard to reason about and easy to misdiagnose.

## What The Redesign Should Optimize For

### Supervisor-Centric Control

The supervisor should own process progression, evidence requirements, and task
selection. Agents should execute bounded tasks rather than carrying the full
workflow authority.

### Evidence-Gated Progression

Moving forward should require explicit evidence and validator outcomes, not just
agent narrative quality.

### Better Isolation Of Bad Reasoning

The system should prefer short-lived task workers for bounded tasks so that a
bad abstraction does not pollute the entire run.

### Explicit Process State

The system needs a machine-readable process ledger, not just conversation text.
This ledger should store:

- discovered features;
- feature status and confidence;
- action-linked evidence records;
- active hypotheses and contradictions;
- model status and compare state;
- current blockers;
- open questions;
- solved-level certification state.

### Stronger Treatment Of Frontier Deltas

A future level should not be treated as "same mechanics plus more routing"
unless the new deltas have been explicitly investigated.

In particular:

- a newly introduced feature cannot be ruled out without action-linked evidence;
- a newly introduced color/value should be treated as a mandatory investigation
  target until proven decorative;
- inherited completion schemas should not dominate frontier planning before new
  deltas are explained.

### Better Observability

If the supervisor becomes more central, its actions must become more observable.
We will need:

- task packets;
- process-ledger diffs;
- validator logs;
- model selection logs;
- fork/reuse decisions and reasons;
- why a task was accepted, retried, or rejected.

## Desired High-Level Outcome

The new design should make the system behave less like:

- "one agent in a long conversation improvises workflow inside a coarse mode"

and more like:

- "a supervisor drives a process with explicit evidence gates and bounded worker
  tasks, using the right model/profile for each task and validating each step
  before allowing progression."

## Non-Goals

This redesign is not trying to:

- eliminate agent autonomy entirely;
- encode game-specific mechanics in the supervisor;
- replace all prompts with hardcoded code paths;
- optimize only for LS20 or any single practice game;
- make the supervisor omniscient instead of observable and disciplined.

## Summary

The motivation for V2 is not just "make the prompt better." The goal is to
change the control model so that:

- the supervisor owns process state and progression;
- evidence and validators gate advancement;
- agents are task workers more often than workflow owners;
- new level deltas cannot be hand-waved away;
- bad reasoning is isolated earlier;
- runtime state is explicit instead of magical.
