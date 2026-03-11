const DEFAULT_STDERR_TAIL_CHARS = 4000;

export function inheritedProcessEnv(overrides?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  if (!overrides) return env;
  return {
    ...env,
    ...overrides,
  };
}

export function appendStderrTail(current: string, chunk: string, maxChars = DEFAULT_STDERR_TAIL_CHARS): string {
  const next = `${current}${chunk}`;
  if (next.length <= maxChars) return next;
  return next.slice(next.length - maxChars);
}

export function annotateErrorWithStderr(message: string, recentStderr: string): Error {
  const stderr = recentStderr.trim();
  if (!stderr) return new Error(message);
  return new Error(`${message}\napp-server stderr:\n${stderr}`);
}
