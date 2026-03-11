type RunConfigVars = Record<string, string>;

const VAR_PATTERN = /\$\{([^}]+)\}/g;
const VAR_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function resolveReference(
  sourcePath: string,
  location: string,
  rawReference: string,
  resolveVars: (name: string) => string | undefined,
): string {
  const reference = rawReference.trim();
  const dot = reference.indexOf(".");
  if (dot <= 0 || dot >= reference.length - 1) {
    throw new Error(
      `${sourcePath}: invalid variable reference '\${${reference}}' at ${location}; expected vars.<name> or env.<NAME>`,
    );
  }
  const scope = reference.slice(0, dot);
  const name = reference.slice(dot + 1).trim();
  if (!name) {
    throw new Error(
      `${sourcePath}: invalid variable reference '\${${reference}}' at ${location}; expected vars.<name> or env.<NAME>`,
    );
  }
  if (scope === "vars") {
    const value = resolveVars(name);
    if (value == null) {
      throw new Error(`${sourcePath}: unresolved variable '\${vars.${name}}' at ${location}`);
    }
    return value;
  }
  if (scope === "env") {
    const value = process.env[name];
    if (value == null) {
      throw new Error(`${sourcePath}: missing environment variable '\${env.${name}}' at ${location}`);
    }
    return value;
  }
  throw new Error(
    `${sourcePath}: unsupported variable scope '${scope}' in '\${${reference}}' at ${location}; expected vars or env`,
  );
}

function interpolateString(
  value: string,
  sourcePath: string,
  location: string,
  resolveVars: (name: string) => string | undefined,
): string {
  return value.replace(VAR_PATTERN, (_match, rawReference) =>
    resolveReference(sourcePath, location, String(rawReference ?? ""), resolveVars)
  );
}

function resolveLocalVars(args: {
  sourcePath: string;
  localRawVars: Record<string, string>;
  inheritedVars: RunConfigVars;
  overrideVars: RunConfigVars;
}): RunConfigVars {
  const { sourcePath, localRawVars, inheritedVars, overrideVars } = args;
  const resolvedLocalVars: RunConfigVars = {};
  const resolving = new Set<string>();

  const resolveVar = (name: string): string | undefined => {
    if (name in overrideVars) return overrideVars[name];
    if (name in resolvedLocalVars) return resolvedLocalVars[name];
    if (!(name in localRawVars)) return inheritedVars[name];
    if (resolving.has(name)) {
      const cycle = [...resolving, name].join(" -> ");
      throw new Error(`${sourcePath}: cyclic vars reference detected (${cycle})`);
    }
    resolving.add(name);
    const resolved = interpolateString(localRawVars[name], sourcePath, `vars.${name}`, (refName) => resolveVar(refName));
    resolving.delete(name);
    resolvedLocalVars[name] = resolved;
    return resolved;
  };

  for (const key of Object.keys(localRawVars)) {
    resolveVar(key);
  }
  return resolvedLocalVars;
}

function interpolateValue(args: {
  value: unknown;
  sourcePath: string;
  location: string;
  vars: RunConfigVars;
}): unknown {
  const { value, sourcePath, location, vars } = args;
  if (typeof value === "string") {
    return interpolateString(value, sourcePath, location, (name) => vars[name]);
  }
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      interpolateValue({
        value: item,
        sourcePath,
        location: `${location}[${index}]`,
        vars,
      })
    );
  }
  const obj = asRecord(value);
  if (!obj) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(obj)) {
    out[key] = interpolateValue({
      value: item,
      sourcePath,
      location: location === "<root>" ? key : `${location}.${key}`,
      vars,
    });
  }
  return out;
}

function parseLocalRawVars(sourcePath: string, value: unknown): Record<string, string> {
  if (value == null) return {};
  const obj = asRecord(value);
  if (!obj) {
    throw new Error(`${sourcePath}: vars must be a mapping of string values`);
  }
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(obj)) {
    if (!VAR_KEY_PATTERN.test(key)) {
      throw new Error(`${sourcePath}: vars.${key} is invalid; keys must match ${VAR_KEY_PATTERN.toString()}`);
    }
    if (typeof raw !== "string") {
      throw new Error(`${sourcePath}: vars.${key} must be a string`);
    }
    out[key] = raw;
  }
  return out;
}

export function interpolateRunConfigVariables(args: {
  raw: unknown;
  sourcePath: string;
  inheritedVars?: RunConfigVars;
  overrideVars?: RunConfigVars;
}): {
  value: unknown;
  vars: RunConfigVars;
} {
  const inheritedVars = args.inheritedVars ?? {};
  const overrideVars = args.overrideVars ?? {};
  const root = asRecord(args.raw);
  if (!root) {
    return {
      value: args.raw,
      vars: { ...inheritedVars, ...overrideVars },
    };
  }
  const localRawVars = parseLocalRawVars(args.sourcePath, root.vars);
  const resolvedLocalVars = resolveLocalVars({
    sourcePath: args.sourcePath,
    localRawVars,
    inheritedVars,
    overrideVars,
  });
  const effectiveVars = { ...inheritedVars, ...resolvedLocalVars, ...overrideVars };
  const value = interpolateValue({
    value: args.raw,
    sourcePath: args.sourcePath,
    location: "<root>",
    vars: effectiveVars,
  });
  return { value, vars: effectiveVars };
}
