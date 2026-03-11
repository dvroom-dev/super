const filesToCheck = [
  "AGENTS.md",
  "package.json",
  "tsconfig.json",
];

const globs = [
  "src/**/*.ts",
  "scripts/**/*.ts",
];

const forbiddenReference = ["agent", "studio"].join("-");
const violations: string[] = [];

for (const relativePath of filesToCheck) {
  const file = Bun.file(relativePath);
  if (!(await file.exists())) continue;
  const text = await file.text();
  if (text.includes(forbiddenReference)) {
    violations.push(`${relativePath}: contains forbidden sibling-runtime reference`);
  }
}

for (const pattern of globs) {
  for await (const relativePath of new Bun.Glob(pattern).scan(".")) {
    const file = Bun.file(relativePath);
    const text = await file.text();
    if (text.includes(forbiddenReference)) {
      violations.push(`${relativePath}: contains forbidden sibling-runtime reference`);
    }
  }
}

if (violations.length > 0) {
  for (const violation of violations) {
    console.error(violation);
  }
  process.exit(1);
}

export {};
