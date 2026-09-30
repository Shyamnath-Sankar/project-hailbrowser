import { useState } from "react";
import { MODEL_SUGGESTIONS } from "../../shared/defaults";
import {
  KEY_OPTIONAL,
  REQUIRES_BASE_URL,
  ROLES,
  applyRoleLink,
  credentialProblem,
  resolveCredentials,
} from "../../shared/credentials";
import type { AgentRole, ProviderId, RoleModel, Settings } from "../../shared/types";
import { rpc } from "../rpc";

const PROVIDERS: ProviderId[] = [
  "anthropic",
  "openai",
  "gemini",
  "openrouter",
  "ollama",
  "openai_compatible",
];

const PROVIDER_LABEL: Record<ProviderId, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  gemini: "Google Gemini",
  openrouter: "OpenRouter",
  ollama: "Ollama (local)",
  openai_compatible: "OpenAI-compatible",
};

/** Base URL placeholders. A provider absent here does not take one. */
const BASE_URL_HINT: Partial<Record<ProviderId, string>> = {
  ollama: "http://localhost:11434/v1",
  openrouter: "https://openrouter.ai/api/v1",
  openai_compatible: "https://your-endpoint.example.com/v1",
};

const ROLE_INFO: Record<AgentRole, { label: string; hint: string }> = {
  planner: {
    label: "Planner",
    hint: "Builds the plan, then repairs it when the work turns out different. Runs rarely, so a strong model costs little here.",
  },
  executor: {
    label: "Executor",
    hint: "Decides every single step. This is where nearly all your spend goes, so favour a fast model.",
  },
  verifier: {
    label: "Verifier",
    hint: "Checks that finished work actually registered. Short prompts, so the cheapest model is fine.",
  },
};

/**
 * Keeps the browser's own autofill and password-manager UI off these fields.
 *
 * Chrome attaches a suggestion dropdown to any text input it thinks it
 * recognizes, and in a narrow side panel that dropdown reads as a search box
 * appearing over the form - it also swallows a paste. `autocomplete="off"` alone
 * is not enough: Chrome's heuristics also key off the field's `name`, so an
 * opaque name is what actually stops the match.
 */
function noAutofill(field: string): Record<string, unknown> {
  return {
    autoComplete: "off",
    autoCorrect: "off",
    autoCapitalize: "off",
    spellCheck: false,
    // Opaque but stable. Chrome's heuristics read the field name, so a name like
    // "url" or "key" invites a suggestion dropdown; a random name per render
    // would avoid that too but would rewrite the attribute on every keystroke.
    name: `pb-${field}`,
    // Honoured by several third-party password managers as "not a login field".
    "data-form-type": "other",
    "data-lpignore": "true",
    "data-1p-ignore": "true",
  };
}

interface TestState {
  status: "running" | "ok" | "error";
  text: string;
}

interface Props {
  settings: Settings;
  onSaved: (settings: Settings) => void;
  needsSetup: boolean;
}

export function SettingsTab({ settings, onSaved, needsSetup }: Props): React.ReactElement {
  const [draft, setDraft] = useState<Settings>(settings);
  const [saveError, setSaveError] = useState("");
  const [tests, setTests] = useState<Partial<Record<AgentRole, TestState>>>({});
  const [overlay, setOverlay] = useState(false);
  const [debugNote, setDebugNote] = useState("");

  const save = async (next: Settings): Promise<void> => {
    const mirrored = applyRoleLink(next);
    setDraft(mirrored);
    next = mirrored;
    try {
      const saved = await rpc<Settings>({ kind: "save_settings", patch: next });
      onSaved(saved);
      setSaveError("");
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    }
  };

  const updateRole = (role: AgentRole, patch: Partial<RoleModel>): void => {
    void save({ ...draft, roles: { ...draft.roles, [role]: { ...draft.roles[role], ...patch } } });
    // A changed model invalidates whatever the last test proved. When roles are
    // linked, that is all of them.
    setTests((prev) => (draft.linkRoles ? {} : { ...prev, [role]: undefined }));
  };

  const updatePolicy = (patch: Partial<Settings["policy"]>): void => {
    void save({ ...draft, policy: { ...draft.policy, ...patch } });
  };

  const runTest = async (role: AgentRole): Promise<void> => {
    setTests((prev) => ({ ...prev, [role]: { status: "running", text: "Sending a test call..." } }));
    try {
      const res = await rpc<{ text: string; usd: number; ms: number }>({
        kind: "test_role",
        role,
      });
      const cost = res.usd > 0 ? `, $${res.usd.toFixed(4)}` : "";
      setTests((prev) => ({
        ...prev,
        [role]: {
          status: "ok",
          text: `Replied in ${(res.ms / 1000).toFixed(1)}s${cost}: "${res.text}"`,
        },
      }));
    } catch (err) {
      setTests((prev) => ({
        ...prev,
        [role]: { status: "error", text: err instanceof Error ? err.message : String(err) },
      }));
    }
  };

  const toggleOverlay = async (): Promise<void> => {
    const next = !overlay;
    setOverlay(next);
    setDebugNote("");
    try {
      await rpc({ kind: "overlay", show: next });
    } catch (err) {
      setDebugNote(err instanceof Error ? err.message : String(err));
      setOverlay(!next);
    }
  };

  return (
    <div className="pane">
      {needsSetup && (
        <div className="card ask">
          <strong>Finish setting up a model to get started.</strong>
          <div className="small" style={{ marginTop: 4 }}>
            You bring your own key: calls are billed to your own account and nothing routes
            through a third party. Each job below can use a different provider — fill in one
            and the others reuse its key automatically.
          </div>
        </div>
      )}

      {saveError && (
        <div className="card" style={{ borderColor: "var(--err)" }}>
          <strong style={{ color: "var(--err)" }}>Could not save</strong>
          <div className="small" style={{ marginTop: 2 }}>{saveError}</div>
        </div>
      )}

      <h3>Models</h3>
      <div className="card">
        <label className="inline" style={{ marginBottom: 0 }}>
          <input
            type="checkbox"
            checked={draft.linkRoles}
            onChange={(e) => void save({ ...draft, linkRoles: e.target.checked })}
          />
          <span style={{ margin: 0 }}>Use one model for everything</span>
        </label>
        <div className="small dim" style={{ marginTop: 4 }}>
          {draft.linkRoles ? (
            <>
              All three jobs share the model below — one thing to fill in and one thing to
              test. Turn this off to give the planner a stronger model and the executor a
              cheaper one, which usually costs less overall.
            </>
          ) : (
            <>
              Each job below is configured separately. Turn this on to point all three at the
              same model instead.
            </>
          )}
        </div>
      </div>

      {draft.linkRoles ? (
        <RoleCard
          role="planner"
          draft={draft}
          test={tests.planner}
          linked
          onChange={(patch) => updateRole("planner", patch)}
          onTest={() => void runTest("planner")}
        />
      ) : (
        ROLES.map((role) => (
          <RoleCard
            key={role}
            role={role}
            draft={draft}
            test={tests[role]}
            onChange={(patch) => updateRole(role, patch)}
            onTest={() => void runTest(role)}
          />
        ))
      )}

      <h3>What the agent may do on its own</h3>
      <div className="card">
        <label className="inline">
          <input
            type="checkbox"
            checked={draft.policy.confirmBeforeSubmit}
            onChange={(e) => updatePolicy({ confirmBeforeSubmit: e.target.checked })}
          />
          <span style={{ margin: 0 }}>Ask me before submitting, sending, buying or deleting</span>
        </label>

        <label style={{ marginTop: 10 }}>
          <span>Graded quizzes and exams</span>
          <select
            value={draft.policy.quizPolicy}
            onChange={(e) =>
              updatePolicy({ quizPolicy: e.target.value as Settings["policy"]["quizPolicy"] })
            }
          >
            <option value="ask">Ask me when one comes up</option>
            <option value="skip">Skip them and carry on</option>
            <option value="auto">Let the agent attempt them</option>
          </select>
        </label>
        {draft.policy.quizPolicy === "auto" && (
          <div className="notice warn">
            Many course platforms and schools forbid automated test-taking. Check the rules that
            apply to you before using this.
          </div>
        )}
      </div>

      <h3>Lesson videos</h3>
      <div className="card">
        <label>
          <span>How to get through a video</span>
          <select
            value={draft.policy.videoStrategy}
            onChange={(e) =>
              updatePolicy({
                videoStrategy: e.target.value as Settings["policy"]["videoStrategy"],
              })
            }
          >
            <option value="skip">Skip to the end — fast</option>
            <option value="watch">Watch it through — reliable</option>
          </select>
        </label>
        <div className="small dim">
          {draft.policy.videoStrategy === "skip" ? (
            <>
              A 20-minute lesson takes a couple of seconds. Not every platform credits it —
              some only count progress reported while a video plays. The agent checks whether
              the lesson actually registered and watches it properly if it did not, so a course
              never looks finished when it is not.
            </>
          ) : (
            <>
              Plays each video to the end, the way the platform expects. Slower on the clock but
              no more expensive — waiting costs nothing.
            </>
          )}
        </div>

        <label className="inline" style={{ marginTop: 10 }}>
          <input
            type="checkbox"
            checked={draft.policy.videoCaptions}
            onChange={(e) => updatePolicy({ videoCaptions: e.target.checked })}
          />
          <span style={{ margin: 0 }}>Turn on captions when a video has them</span>
        </label>
        <div className="small dim">
          How the agent gets a transcript to take notes from, which is what a later quiz draws
          on.
          {draft.policy.videoStrategy === "skip" && (
            <> When skipping, it is the only record of what the lesson said.</>
          )}
        </div>

        {/* Speed and stall tolerance mean nothing unless a video is actually playing. */}
        {draft.policy.videoStrategy === "watch" && (
          <>
            <label style={{ marginTop: 10 }}>
              <span>Playback speed</span>
              <select
                value={draft.policy.videoRate}
                onChange={(e) => updatePolicy({ videoRate: Number(e.target.value) })}
              >
                <option value={1}>Normal speed</option>
                <option value={1.25}>1.25×</option>
                <option value={1.5}>1.5× — about a third less time</option>
                <option value={2}>2× — half the time</option>
              </select>
            </label>
            <div className="small dim">
              Many players cap or ignore this; the agent uses whatever speed actually took
              effect.
              {draft.policy.videoRate > 1 && (
                <> Some platforms only credit a lesson watched at normal speed.</>
              )}
            </div>

            <label style={{ marginTop: 10 }}>
              <span>Give up on a stalled video after</span>
              <select
                value={draft.policy.videoStallSeconds}
                onChange={(e) => updatePolicy({ videoStallSeconds: Number(e.target.value) })}
              >
                <option value={20}>20 seconds</option>
                <option value={45}>45 seconds — recommended</option>
                <option value={90}>90 seconds</option>
                <option value={180}>3 minutes</option>
              </select>
            </label>
            <div className="small dim">
              When playback stops advancing — an ad, a &ldquo;still watching?&rdquo; prompt, a
              buffering failure — the agent looks at the page instead of sitting out the full
              video length.
            </div>
          </>
        )}
      </div>

      <h3>Budget per task</h3>
      <div className="card">
        <div className="row" style={{ gap: 6, alignItems: "flex-start" }}>
          <label className="grow" style={{ marginBottom: 0 }}>
            <span>Max spend ($)</span>
            <input
              type="number"
              min={0.5}
              step={0.5}
              value={draft.policy.maxUsd}
              onChange={(e) => updatePolicy({ maxUsd: Number(e.target.value) })}
            />
          </label>
          <label className="grow" style={{ marginBottom: 0 }}>
            <span>Max steps</span>
            <input
              type="number"
              min={10}
              step={50}
              value={draft.policy.maxSteps}
              onChange={(e) => updatePolicy({ maxSteps: Number(e.target.value) })}
            />
          </label>
          <label className="grow" style={{ marginBottom: 0 }}>
            <span>Max minutes</span>
            <input
              type="number"
              min={5}
              step={30}
              value={draft.policy.maxMinutes}
              onChange={(e) => updatePolicy({ maxMinutes: Number(e.target.value) })}
            />
          </label>
        </div>
        <div className="small dim" style={{ marginTop: 6 }}>
          Hitting a limit pauses the task and asks whether to keep going, rather than quitting.
          Spend only counts models we know the price of.
        </div>
      </div>

      <details className="fold">
        <summary>Advanced</summary>

        <label style={{ marginTop: 10 }}>
          <span>Screenshots sent to the model</span>
          <select
            value={draft.vision}
            onChange={(e) => void save({ ...draft, vision: e.target.value as Settings["vision"] })}
          >
            <option value="auto">Only when the text is not enough — cheapest</option>
            <option value="always">Every step</option>
            <option value="never">Never</option>
          </select>
        </label>
        <div className="small dim">
          Screenshots are the single biggest cost lever. On &ldquo;auto&rdquo; they are sent for a
          blank page, a repeated failure, or a CAPTCHA.
        </div>

        <div style={{ marginTop: 12 }}>
          <button onClick={() => void toggleOverlay()}>
            {overlay ? "Hide" : "Show"} element numbers on the page
          </button>
          <div className="small dim" style={{ marginTop: 4 }}>
            Draws the numbered boxes the agent sees, so you can tell whether it is misreading the
            page or misjudging it.
          </div>
          {debugNote && (
            <div className="small" style={{ color: "var(--err)", marginTop: 4 }}>
              {debugNote}
            </div>
          )}
        </div>

        <div className="notice" style={{ marginTop: 12 }}>
          Keys are kept in this extension&rsquo;s local storage, which is not strongly protected:
          anything with access to your browser profile can read them. Use keys you can rotate, and
          set a spend cap with your provider.
        </div>
      </details>
    </div>
  );
}

function RoleCard({
  role,
  draft,
  test,
  linked = false,
  onChange,
  onTest,
}: {
  role: AgentRole;
  draft: Settings;
  test: TestState | undefined;
  /** This one card stands in for all three roles. */
  linked?: boolean;
  onChange: (patch: Partial<RoleModel>) => void;
  onTest: () => void;
}): React.ReactElement {
  const slot = draft.roles[role];
  const info = linked
    ? {
        label: "All agents",
        hint: "Plans the work, runs every step, and checks that finished work registered.",
      }
    : ROLE_INFO[role];
  const resolved = resolveCredentials(draft, role);
  const problem = credentialProblem(draft, role);
  const takesBaseUrl = BASE_URL_HINT[slot.provider] !== undefined;
  const baseUrlRequired = REQUIRES_BASE_URL.includes(slot.provider);
  const keyOptional = KEY_OPTIONAL.includes(slot.provider);
  const suggestions = MODEL_SUGGESTIONS[slot.provider] ?? [];

  // A blank field that resolves anyway is inheriting from elsewhere. Saying so
  // stops the field from looking broken.
  const keyPlaceholder = resolved.keyFrom
    ? `Using the ${resolved.keyFrom === "shared" ? "saved" : resolved.keyFrom} key`
    : keyOptional
      ? "Not needed for this provider"
      : "sk-...";

  return (
    <div className="card role">
      <div className="row spread" style={{ marginBottom: 2 }}>
        <strong>{info.label}</strong>
        <span className={`badge ${problem ? "" : "done"}`}>{problem ?? "ready"}</span>
      </div>
      <div className="small dim" style={{ marginBottom: 8 }}>
        {info.hint}
      </div>

      <div className="field-grid">
        <label style={{ marginBottom: 0 }}>
          <span>Provider</span>
          <select
            value={slot.provider}
            onChange={(e) => {
              const provider = e.target.value as ProviderId;
              // Offer that provider's first suggestion, since the old model name
              // is meaningless to a different vendor.
              const model = MODEL_SUGGESTIONS[provider]?.[0] ?? "";
              onChange({ provider, model });
            }}
            aria-label={`${info.label} provider`}
          >
            {PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {PROVIDER_LABEL[p]}
              </option>
            ))}
          </select>
        </label>

        <label style={{ marginBottom: 0 }}>
          <span>Model</span>
          {/* No datalist here: its dropdown reads as a search box over a narrow
              panel, and it hijacks paste. Suggestions are buttons below instead. */}
          <input
            {...noAutofill(`model-${role}`)}
            value={slot.model}
            placeholder={slot.provider === "openai_compatible" ? "as your endpoint names it" : ""}
            onChange={(e) => onChange({ model: e.target.value })}
            aria-label={`${info.label} model`}
          />
        </label>
      </div>

      {suggestions.length > 0 && (
        <div className="row wrap chips" style={{ marginTop: 6 }}>
          {suggestions.map((m) => (
            <button
              key={m}
              type="button"
              className={`chip ${slot.model === m ? "on" : ""}`}
              onClick={() => onChange({ model: m })}
            >
              {m}
            </button>
          ))}
        </div>
      )}

      {takesBaseUrl && (
        <label style={{ marginTop: 8, marginBottom: 0 }}>
          <span>Base URL {baseUrlRequired ? "(required)" : "(optional)"}</span>
          <input
            {...noAutofill(`baseurl-${role}`)}
            type="text"
            inputMode="url"
            value={slot.baseUrl ?? ""}
            placeholder={
              resolved.baseUrlFrom
                ? `Using the ${resolved.baseUrlFrom === "shared" ? "saved" : resolved.baseUrlFrom} URL`
                : BASE_URL_HINT[slot.provider]
            }
            onChange={(e) => onChange({ baseUrl: e.target.value })}
            aria-label={`${info.label} base URL`}
          />
        </label>
      )}

      <label style={{ marginTop: 8, marginBottom: 0 }}>
        <span>API key {keyOptional ? "(optional)" : ""}</span>
        <input
          {...noAutofill(`apikey-${role}`)}
          type="password"
          // Chrome ignores autocomplete="off" on password fields but honours
          // "new-password", which is what keeps the saved-passwords bar away.
          autoComplete="new-password"
          value={slot.apiKey ?? ""}
          placeholder={keyPlaceholder}
          onChange={(e) => onChange({ apiKey: e.target.value })}
          aria-label={`${info.label} API key`}
        />
      </label>

      {slot.provider === "openai_compatible" && (
        <div className="small dim" style={{ marginTop: 6 }}>
          Anything speaking <span className="mono">/chat/completions</span>: vLLM, LM Studio,
          llama.cpp, Together, Groq, Fireworks, Azure OpenAI, a company gateway. Paste the URL up
          to <span className="mono">/v1</span> — the rest of the path is added for you.
        </div>
      )}

      {slot.provider === "anthropic" && (
        <label style={{ marginTop: 8, marginBottom: 0 }}>
          <span>Reasoning effort</span>
          <select
            value={slot.effort ?? "medium"}
            onChange={(e) => onChange({ effort: e.target.value as RoleModel["effort"] })}
            aria-label={`${info.label} reasoning effort`}
          >
            <option value="low">Low — fastest</option>
            <option value="medium">Medium</option>
            <option value="high">High — more thorough</option>
          </select>
        </label>
      )}

      <div className="row" style={{ marginTop: 10, gap: 8 }}>
        <button onClick={onTest} disabled={problem !== null || test?.status === "running"}>
          {test?.status === "running" ? "Testing..." : "Test this model"}
        </button>
        {test && test.status !== "running" && (
          <span className={`small ${test.status === "ok" ? "ok-text" : "err-text"}`}>
            {test.status === "ok" ? "Works" : "Failed"}
          </span>
        )}
      </div>

      {test && (
        <div
          className={`notice ${test.status === "error" ? "err" : ""}`}
          style={{ marginTop: 6, marginBottom: 0 }}
        >
          {test.text}
        </div>
      )}
    </div>
  );
}
