/**
 * The configuration page.
 *
 * It only *selects*: providers, models and MCP servers all come from Claude
 * Code Router, so a provider added there appears here without a sync step.
 * Reasoning is stored provider-neutrally and mapped per model by the harness —
 * this page renders the mapper's diagnostics rather than encoding any model's
 * rules itself.
 */
import { useMemo, useState } from "react";
// Subpath import on purpose: the package index pulls in SQLite and node:fs,
// which have no business in a sandboxed renderer. This module is pure.
import { mapReasoning } from "@ccx/harness/reasoning/map";
import type { ReasoningPreference } from "@ccx/harness/reasoning/map";
import type { ReasoningEffort } from "@ccx/harness/reasoning/capabilities";
import { reasoningEffortOptions, reasoningModeOptions } from "../reasoning-config";

export type ModeDraft = {
  mcpServers: string[];
  model: string;
  reasoning: ReasoningPreference;
  skills: string[];
};

export type ConfigurationProps = {
  availableMcpServers: string[];
  availableModels: Array<{ id: string; model: string; provider: string }>;
  availableSkills: Array<{ description: string; name: string }>;
  draft: ModeDraft;
  mode: "code" | "work";
  onChange: (draft: ModeDraft) => void;
  onClose: () => void;
};

export function Configuration({
  availableMcpServers,
  availableModels,
  availableSkills,
  draft,
  mode,
  onChange,
  onClose
}: ConfigurationProps) {
  const [saved, setSaved] = useState(false);

  // Ask the harness what this preference actually becomes on this model.
  const mapping = useMemo(
    () => mapReasoning({ model: draft.model, preference: draft.reasoning }),
    [draft.model, draft.reasoning]
  );

  const update = (patch: Partial<ModeDraft>) => {
    setSaved(true);
    onChange({ ...draft, ...patch });
  };

  return (
    <section className="config" aria-label="Configuration">
      <header className="config-head">
        <h1>
          Configuration <span className={`badge ${mode}`}>{mode}</span>
        </h1>
        <button onClick={onClose} type="button">
          Done
        </button>
      </header>

      <div className="field">
        <label htmlFor="model">Model</label>
        {availableModels.length === 0 ? (
          <p className="hint warn">
            No models are available. Add a provider in Claude Code Router first.
          </p>
        ) : (
          <select
            id="model"
            onChange={(event) => update({ model: event.target.value })}
            value={draft.model}
          >
            {availableModels.map((choice) => (
              <option key={choice.id} value={choice.id}>
                {choice.provider ? `${choice.provider} · ${choice.model}` : choice.model}
              </option>
            ))}
          </select>
        )}
        <p className="hint">Providers and models come from Claude Code Router.</p>
      </div>

      <fieldset className="field">
        <legend>Reasoning</legend>
        <div className="row">
          <label htmlFor="reasoning-mode">Mode</label>
          <select
            id="reasoning-mode"
            onChange={(event) =>
              update({ reasoning: { ...draft.reasoning, mode: event.target.value as ReasoningPreference["mode"] } })
            }
            value={draft.reasoning.mode}
          >
            {reasoningModeOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className="row">
          <label htmlFor="reasoning-effort">Effort</label>
          <select
            id="reasoning-effort"
            onChange={(event) =>
              update({
                reasoning: { ...draft.reasoning, effort: event.target.value as ReasoningEffort | "auto" }
              })
            }
            value={draft.reasoning.effort}
          >
            {reasoningEffortOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <label className="check">
          <input
            checked={draft.reasoning.showReasoning}
            onChange={(event) =>
              update({ reasoning: { ...draft.reasoning, showReasoning: event.target.checked } })
            }
            type="checkbox"
          />
          Show the model's reasoning
        </label>

        {/* What the preference becomes on this model, said before it fails. */}
        {mapping.diagnostics.length > 0 ? (
          <ul className="diagnostics">
            {mapping.diagnostics.map((diagnostic) => (
              <li key={diagnostic.code}>{diagnostic.detail}</li>
            ))}
          </ul>
        ) : null}
      </fieldset>

      <fieldset className="field">
        <legend>MCP servers</legend>
        {availableMcpServers.length === 0 ? (
          <p className="hint">None configured in Claude Code Router.</p>
        ) : (
          availableMcpServers.map((name) => (
            <label className="check" key={name}>
              <input
                checked={draft.mcpServers.length === 0 || draft.mcpServers.includes(name)}
                onChange={(event) =>
                  update({ mcpServers: toggle(draft.mcpServers, availableMcpServers, name, event.target.checked) })
                }
                type="checkbox"
              />
              {name}
            </label>
          ))
        )}
        {mode === "work" ? (
          <p className="hint">Work mode has no shell and cannot write files.</p>
        ) : null}
      </fieldset>

      <fieldset className="field">
        <legend>Skills</legend>
        {availableSkills.length === 0 ? (
          <p className="hint">No skills found for this harness.</p>
        ) : (
          availableSkills.map((skill) => (
            <label className="check" key={skill.name}>
              <input
                checked={draft.skills.length === 0 || draft.skills.includes(skill.name)}
                onChange={(event) =>
                  update({
                    skills: toggle(draft.skills, availableSkills.map((entry) => entry.name), skill.name, event.target.checked)
                  })
                }
                type="checkbox"
              />
              <span>
                {skill.name}
                <span className="hint inline">{skill.description}</span>
              </span>
            </label>
          ))
        )}
      </fieldset>

      {saved ? <p className="saved" role="status">Saved.</p> : null}
    </section>
  );
}

/**
 * An empty list means "all", so the first time something is unticked the list
 * has to be materialised from everything available — otherwise unticking one
 * server would read as enabling only that one.
 */
function toggle(current: string[], all: string[], name: string, checked: boolean): string[] {
  const base = current.length === 0 ? [...all] : [...current];
  const next = checked ? [...new Set([...base, name])] : base.filter((entry) => entry !== name);
  return next.length === all.length ? [] : next;
}
