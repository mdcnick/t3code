import type { ServerProviderSkill } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { searchProviderSkills } from "../../providerSkillSearch";
import {
  composerSkillInsertion,
  composerSkillNames,
  pendingComposerSkills,
} from "./composerSkillPicker.logic";

function skill(name: string, overrides: Partial<ServerProviderSkill> = {}): ServerProviderSkill {
  return { name, path: `/skills/${name}/SKILL.md`, enabled: true, ...overrides };
}

const skills = [skill("review"), skill("design"), skill("test")];

describe("composer skill picker", () => {
  it("recognizes native mentions and currency aliases without counting prose", () => {
    expect(
      composerSkillNames("review $review €design\n$review $unknown $100 prefix$test", skills),
    ).toEqual(["review", "design"]);
  });

  it("dedupes selections, keeping the first invocable definition and canonical name", () => {
    const first = skill("review", { path: "/project/review/SKILL.md" });
    expect(
      pendingComposerSkills("", [" REVIEW ", "review", "design", "missing"], [
        skill("review", { enabled: false }),
        first,
        skill("REVIEW", { path: "/personal/review/SKILL.md" }),
        skill("design", { userInvocable: false }),
      ]),
    ).toEqual([first]);
  });

  it("revalidates against current prompt and catalog when applying a staged selection", () => {
    const staged = ["review", "design", "test"];
    const updatedSkills = [skill("review"), skill("design", { enabled: false })];
    expect(pendingComposerSkills("Already €review ", staged, updatedSkills)).toEqual([]);
    expect(composerSkillInsertion("Already €review ", staged, updatedSkills)).toBe("");
  });

  it.each([
    ["", "$review $design "],
    ["Please inspect", " $review $design "],
    ["Please inspect ", "$review $design "],
    ["Please inspect\n", "$review $design "],
  ])("inserts native tokens with safe whitespace after %j", (prompt, expected) => {
    const insertion = composerSkillInsertion(prompt, ["review", "design", "review"], skills);
    expect(insertion).toBe(expected);
    expect(composerSkillNames(prompt + insertion, skills)).toEqual(["review", "design"]);
    expect(composerSkillInsertion(prompt + insertion, ["review", "design"], skills)).toBe("");
  });

  it("keeps selections across search filters, using the existing provider skill ranking", () => {
    const catalog = [
      skill("review", { shortDescription: "Audit security boundaries" }),
      skill("design", { displayName: "Interface polish" }),
      skill("hidden", { userInvocable: false, description: "Audit security" }),
    ];
    const selected = ["design", "review"];
    expect(searchProviderSkills(catalog, "security").map((item) => item.name)).toEqual(["review"]);
    expect(searchProviderSkills(catalog, "Interface").map((item) => item.name)).toEqual(["design"]);
    expect(pendingComposerSkills("", selected, catalog).map((item) => item.name)).toEqual(selected);
  });
});
