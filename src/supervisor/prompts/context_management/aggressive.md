Context management strategy: aggressive

Apply maximum-aggression context reduction.
- Offloading: high. Offload most non-critical tool output and historical detail to .ai-supervisor files with `<full results at ...>` references.
- Summarization: high. Convert bulky command output to concise factual summaries (for example, command outcome + affected rows/files) while keeping references to full output.
- Trimming: high. Remove non-essential dead ends, repeated failures, and obsolete context promptly.
- Keep relevant code/context inline while it is actively used; aggressively offload stale code/output once newer turns supersede it.

Prioritize context budget and execution velocity; preserve only information required for correctness and safety checks.
