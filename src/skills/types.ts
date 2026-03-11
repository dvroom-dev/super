export type SkillScope = "repo" | "user" | "system" | "admin";

export type SkillMetadata = {
  name: string;
  description: string;
  path: string;
  scope: SkillScope;
};

export type SkillError = {
  path: string;
  message: string;
};

export type SkillLoadOutcome = {
  skills: SkillMetadata[];
  errors: SkillError[];
};

export type SkillInstruction = {
  name: string;
  path: string;
  contents: string;
};
