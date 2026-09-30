import { useEffect, useState } from "react";
import type { SkillLike } from "../../shared/messages";
import type { PageType } from "../../shared/types";
import { rpc } from "../rpc";

const PAGE_TYPES: PageType[] = [
  "video", "reading", "quiz", "instructions", "form", "login", "captcha", "listing", "unknown",
];

const BLANK: SkillLike = {
  name: "",
  pageTypes: [],
  hosts: [],
  description: "",
  body: "",
  builtin: false,
};

/**
 * Skills the agent can load mid-task. Only the description is ever in the
 * prompt; the body arrives when the agent asks for it, which keeps context small
 * no matter how many skills exist.
 */
export function Skills(): React.ReactElement {
  const [rows, setRows] = useState<SkillLike[]>([]);
  const [editing, setEditing] = useState<SkillLike | null>(null);
  const [error, setError] = useState("");

  const load = (): void => {
    void rpc<SkillLike[]>({ kind: "list_skills" })
      .then(setRows)
      .catch((err: unknown) => setError(String(err)));
  };

  useEffect(load, []);

  const save = async (): Promise<void> => {
    if (!editing) return;
    const name = editing.name.trim();
    if (!name || !editing.body.trim()) {
      setError("A skill needs a name and a body.");
      return;
    }
    setError("");
    await rpc({ kind: "save_skill", skill: { ...editing, name } });
    setEditing(null);
    load();
  };

  const remove = async (name: string): Promise<void> => {
    await rpc({ kind: "delete_skill", name });
    load();
  };

  if (editing) {
    return (
      <div className="pane">
        <h2>{rows.some((r) => r.name === editing.name) ? "Edit skill" : "New skill"}</h2>

        <label>
          <span>Name</span>
          <input
            value={editing.name}
            placeholder="coursera-navigation"
            onChange={(e) => setEditing({ ...editing, name: e.target.value })}
          />
        </label>

        <label>
          <span>One-line description (this is what the agent sees before loading it)</span>
          <input
            value={editing.description}
            placeholder="Move between Coursera lessons and mark them complete"
            onChange={(e) => setEditing({ ...editing, description: e.target.value })}
          />
        </label>

        <label>
          <span>Hosts (comma separated, blank = any site)</span>
          <input
            value={editing.hosts.join(", ")}
            placeholder="coursera.org, udemy.com"
            onChange={(e) =>
              setEditing({
                ...editing,
                hosts: e.target.value.split(",").map((s) => s.trim()).filter(Boolean),
              })
            }
          />
        </label>

        <label>
          <span>Page types (blank = any)</span>
          <div className="row wrap" style={{ gap: 8 }}>
            {PAGE_TYPES.map((type) => (
              <label key={type} className="inline small" style={{ marginBottom: 0 }}>
                <input
                  type="checkbox"
                  checked={editing.pageTypes.includes(type)}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      pageTypes: e.target.checked
                        ? [...editing.pageTypes, type]
                        : editing.pageTypes.filter((t) => t !== type),
                    })
                  }
                />
                {type}
              </label>
            ))}
          </div>
        </label>

        <label>
          <span>Procedure — numbered steps the agent should follow</span>
          <textarea
            rows={14}
            value={editing.body}
            placeholder={"1. ...\n2. ..."}
            onChange={(e) => setEditing({ ...editing, body: e.target.value })}
          />
        </label>

        {error && <div className="small" style={{ color: "var(--err)" }}>{error}</div>}

        <div className="row">
          <button className="primary" onClick={() => void save()}>
            Save
          </button>
          <button onClick={() => { setEditing(null); setError(""); }}>Cancel</button>
        </div>
      </div>
    );
  }

  return (
    <div className="pane">
      <div className="row spread" style={{ marginBottom: 8 }}>
        <h2>Skills</h2>
        <button onClick={() => setEditing({ ...BLANK })}>New</button>
      </div>

      {error && <div className="small" style={{ color: "var(--err)" }}>{error}</div>}

      {rows.map((row) => (
        <div key={row.name} className="card">
          <div className="row spread" style={{ marginBottom: 4 }}>
            <strong>{row.name}</strong>
            <span className="row" style={{ gap: 6 }}>
              {row.builtin && <span className="badge">built-in</span>}
              <button className="link small" onClick={() => setEditing({ ...row })}>
                {row.builtin ? "copy" : "edit"}
              </button>
              {!row.builtin && (
                <button className="link small danger" onClick={() => void remove(row.name)}>
                  delete
                </button>
              )}
            </span>
          </div>
          <div className="small">{row.description}</div>
          <div className="small dim" style={{ marginTop: 4 }}>
            {row.pageTypes.length ? row.pageTypes.join(", ") : "any page"}
            {row.hosts.length ? ` · ${row.hosts.join(", ")}` : ""}
          </div>
        </div>
      ))}
    </div>
  );
}
