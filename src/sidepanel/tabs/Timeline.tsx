import { useState } from "react";
import type { StepRecord } from "../../shared/types";

/** Every step the agent took, with what it intended and what actually happened. */
export function Timeline({ steps }: { steps: StepRecord[] }): React.ReactElement {
  const [open, setOpen] = useState<string | null>(null);

  if (!steps.length) {
    return (
      <div className="pane">
        <div className="empty">No steps yet.</div>
      </div>
    );
  }

  return (
    <div className="pane">
      <h2>Steps</h2>
      {[...steps].reverse().map((step) => {
        const failed = step.results.some((r) => !r.ok);
        const expanded = open === step.id;
        return (
          <div key={step.id} className={`step ${failed ? "failed" : ""}`}>
            <div className="row spread">
              <span className="step-goal">
                #{step.index} {step.nextGoal}
              </span>
              <button className="link small" onClick={() => setOpen(expanded ? null : step.id)}>
                {expanded ? "less" : "more"}
              </button>
            </div>

            <div className="small dim" style={{ marginTop: 2 }}>
              {step.actions.map((a) => a.type).join(" → ")}
            </div>

            {expanded && (
              <div className="small" style={{ marginTop: 6 }}>
                <div style={{ marginBottom: 4 }}>
                  <strong>Checked last step:</strong> {step.evaluation || "(nothing)"}
                </div>
                <div style={{ marginBottom: 4 }}>
                  <strong>Carried forward:</strong> {step.memory || "(nothing)"}
                </div>
                <div className="mono dim" style={{ marginBottom: 4, overflowWrap: "anywhere" }}>
                  {step.url}
                </div>
                <ul style={{ margin: "4px 0 0", paddingLeft: 16 }}>
                  {step.results.map((result, i) => (
                    <li key={i} style={{ color: result.ok ? undefined : "var(--err)" }}>
                      {result.detail}
                      {result.data && (
                        <div className="mono dim" style={{ marginTop: 2, whiteSpace: "pre-wrap" }}>
                          {result.data.slice(0, 600)}
                          {result.data.length > 600 ? "…" : ""}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
                <div className="dim mono" style={{ marginTop: 4 }}>
                  ${step.usd.toFixed(4)} · {new Date(step.at).toLocaleTimeString()}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
