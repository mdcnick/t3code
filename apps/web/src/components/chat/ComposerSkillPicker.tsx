import type { ServerProviderSkill } from "@t3tools/contracts";
import { resolveProviderSkillSourceKind } from "@t3tools/client-runtime/providerSkills";
import { formatProviderSkillDisplayName } from "@t3tools/shared/inlineSkills";
import { SparklesIcon } from "lucide-react";
import { useRef, useState } from "react";

import { searchProviderSkills } from "../../providerSkillSearch";
import { Button } from "../ui/button";
import { CheckboxMark } from "../ui/checkbox";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
} from "../ui/combobox";
import { SkillSourceBadge } from "./ComposerCommandMenu";
import { composerSkillNames, pendingComposerSkills } from "./composerSkillPicker.logic";
import { composerFloatingLayerProps } from "./composerEventScope";

const MAX_VISIBLE_SKILLS = 80;

export function ComposerSkillPicker({
  skills,
  prompt,
  scanning,
  disabled,
  onOpen,
  onAdd,
}: {
  skills: readonly ServerProviderSkill[];
  prompt: string;
  scanning: boolean;
  disabled: boolean;
  onOpen: () => void;
  onAdd: (names: readonly string[]) => void;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const addedRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedNames, setSelectedNames] = useState<string[]>([]);
  const available = searchProviderSkills(skills, "");
  const existingNames = composerSkillNames(prompt, available);
  const existing = new Set(existingNames);
  const pending = pendingComposerSkills(prompt, selectedNames, available);
  const selected = [...existingNames, ...pending.map((skill) => skill.name)];
  const matches = searchProviderSkills(available, query);
  const visible = open ? matches.slice(0, MAX_VISIBLE_SKILLS) : [];

  return (
    <Combobox
      multiple
      autoHighlight
      open={open && !disabled}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen) {
          addedRef.current = false;
          setQuery("");
          setSelectedNames([]);
          onOpen();
        }
      }}
      items={available.map((skill) => skill.name)}
      filteredItems={visible.map((skill) => skill.name)}
      value={selected}
      onValueChange={setSelectedNames}
    >
      <ComboboxTrigger
        ref={triggerRef}
        disabled={disabled}
        render={<Button variant="ghost-muted" size="sm" />}
        aria-label={
          existingNames.length > 0 ? `Skills, ${existingNames.length} in prompt` : "Skills"
        }
        title="Choose skills for this message"
      >
        <SparklesIcon aria-hidden="true" />
        Skills{existingNames.length > 0 ? ` (${existingNames.length})` : ""}
      </ComboboxTrigger>
      <ComboboxPopup
        {...composerFloatingLayerProps}
        anchor={triggerRef}
        initialFocus={searchRef}
        finalFocus={() => (addedRef.current ? false : triggerRef.current)}
        side="top"
        align="start"
        className="w-96"
      >
        <div className="shrink-0 px-3 pt-3">
          <h2 className="text-sm font-medium">Skills for this message</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Add native skill mentions. Remove chips in the prompt to deselect.
          </p>
        </div>
        <ComboboxSearchInput
          ref={searchRef}
          aria-label="Search skills"
          placeholder="Search skills…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="min-h-0 flex-1 overflow-hidden">
          <ComboboxEmpty>
            {scanning
              ? "Discovering workspace skills…"
              : available.length === 0
                ? "No invocable skills found for this provider and workspace."
                : "No matching skills. Try a name or description."}
          </ComboboxEmpty>
          <ComboboxList aria-label="Available skills">
            {visible.map((skill) => {
              const label = formatProviderSkillDisplayName(skill);
              const description = skill.shortDescription?.trim() || skill.description?.trim();
              const inPrompt = existing.has(skill.name);
              return (
                <ComboboxItem key={skill.name} value={skill.name} disabled={inPrompt}>
                  <CheckboxMark checked={selected.includes(skill.name)} />
                  <div className="min-w-0 flex-1 py-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate font-medium" title={label}>
                        {label}
                      </span>
                      <span className="ms-auto shrink-0" title={skill.path}>
                        <SkillSourceBadge
                          kind={resolveProviderSkillSourceKind(skill)}
                          showSkillSuffix={false}
                        />
                      </span>
                    </div>
                    {label !== skill.name ? (
                      <p className="truncate text-xs text-muted-foreground">${skill.name}</p>
                    ) : null}
                    {description ? (
                      <p
                        className="mt-0.5 line-clamp-2 text-xs text-muted-foreground"
                        title={description}
                      >
                        {description}
                      </p>
                    ) : null}
                    {inPrompt ? (
                      <p className="mt-0.5 text-xs text-muted-foreground">In prompt</p>
                    ) : null}
                  </div>
                </ComboboxItem>
              );
            })}
          </ComboboxList>
        </div>
        <div className="shrink-0 border-t border-border/60 px-3 py-2">
          <p role="status" className="mb-2 text-xs text-muted-foreground">
            {pending.length} selected · {existingNames.length} in prompt
            {scanning ? " · Discovering skills…" : ""}
            {matches.length > MAX_VISIBLE_SKILLS
              ? ` · Showing ${MAX_VISIBLE_SKILLS} of ${matches.length}; search to narrow.`
              : ""}
          </p>
          <div className="flex items-center justify-between gap-2">
            <Button variant="ghost-muted" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={pending.length === 0}
              onClick={() => {
                addedRef.current = true;
                onAdd(pending.map((skill) => skill.name));
                setOpen(false);
              }}
            >
              Add{pending.length > 0 ? ` ${pending.length}` : ""}
              {pending.length === 1 ? " skill" : " skills"}
            </Button>
          </div>
        </div>
      </ComboboxPopup>
    </Combobox>
  );
}
