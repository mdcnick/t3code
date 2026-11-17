import type { ServerProviderSkill } from "@t3tools/contracts";
import { matchInlineSkills } from "@t3tools/shared/inlineSkills";
import { searchProviderSkills } from "../../providerSkillSearch";

export function composerSkillNames(
  prompt: string,
  skills: readonly ServerProviderSkill[],
): string[] {
  return [...new Set([...matchInlineSkills(prompt, skills)].map(({ skill }) => skill.name))];
}

export function pendingComposerSkills(
  prompt: string,
  selectedNames: readonly string[],
  skills: readonly ServerProviderSkill[],
): ServerProviderSkill[] {
  const available = searchProviderSkills(skills, "");
  const existing = new Set(composerSkillNames(prompt, available).map((name) => name.toLowerCase()));
  const byName = new Map(available.map((skill) => [skill.name.toLowerCase(), skill]));
  const pending: ServerProviderSkill[] = [];
  for (const name of selectedNames) {
    const key = name.trim().toLowerCase();
    const skill = byName.get(key);
    if (!skill || existing.has(key)) continue;
    existing.add(key);
    pending.push(skill);
  }
  return pending;
}

export function composerSkillInsertion(
  prompt: string,
  selectedNames: readonly string[],
  skills: readonly ServerProviderSkill[],
): string {
  const pending = pendingComposerSkills(prompt, selectedNames, skills);
  if (pending.length === 0) return "";
  const separator = prompt.length > 0 && !/\s$/u.test(prompt) ? " " : "";
  return `${separator}${pending.map((skill) => `$${skill.name}`).join(" ")} `;
}
