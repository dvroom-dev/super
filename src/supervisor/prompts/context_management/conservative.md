Context management strategy: conservative

Apply low-aggression context management.
- Offloading: low. Offload only very large tool outputs or repeated low-value logs into .ai-supervisor files; keep useful details inline.
- Summarization: low. Summarize only when content is redundant; preserve step-by-step evidence needed for rule checks.
- Trimming: low. Remove only clearly invalid noise (duplicate failures, empty retries, malformed blocks).

Prefer preserving fidelity over compactness unless budgets force reduction.
