import type { FluxEvent, FluxQueueSnapshot, FluxRunState } from "./types.js";

export function formatFluxState(state: FluxRunState | null): string {
  if (!state) return "No flux state found.";
  return JSON.stringify(state, null, 2);
}

export function formatFluxQueue(snapshot: FluxQueueSnapshot): string {
  return JSON.stringify(snapshot, null, 2);
}

export function formatFluxEvents(events: FluxEvent[], tail = 50): string {
  const sliced = tail > 0 ? events.slice(-tail) : events;
  return JSON.stringify(sliced, null, 2);
}
