import { useCallback, useEffect, useState } from "react";
import type { Memory } from "../../shared/types";
import { rpc } from "../rpc";

/**
 * What the agent remembers, and the controls to correct it. Pinned items go
 * into every prompt in their scope, which is how test rules captured on one
 * page are still known twenty steps later.
 */
export function MemoryTab({ taskId }: { taskId: string | null }): React.ReactElement {
  const [rows, setRows] = useState<Memory[]>([]);
  const [scope, setScope] = useState<"task" | "all">(taskId ? "task" : "all");
  const [error, setError] = useState("");

  const load = useCallback(() => {
    const target = scope === "task" ? taskId : null;
    void rpc<Memory[]>({ kind: "list_memories", taskId: target })
      .then(setRows)
      .catch((err: unknown) => setError(String(err)));
  }, [scope, taskId]);

  useEffect(load, [load]);

  const togglePin = async (row: Memory): Promise<void> => {
    await rpc({ kind: "pin_memory", id: row.id, pinned: !row.pinned });
    load();
  };

  const forget = async (row: Memory): Promise<void> => {
    await rpc({ kind: "forget_memory", id: row.id });
    load();
  };

  const pinned = rows.filter((r) => r.pinned);
  const rest = rows.filter((r) => !r.pinned);

  return (
    <div className="pane">
      <div className="row spread" style={{ marginBottom: 8 }}>
        <h2>Memory</h2>
        <select
          style={{ width: "auto" }}
          value={scope}
          onChange={(e) => setScope(e.target.value as "task" | "all")}
          aria-label="Memory scope"
        >
          <option value="task" disabled={!taskId}>
            This task
          </option>
          <option value="all">Everything</option>
        </select>
      </div>

      {error && <div className="small" style={{ color: "var(--err)" }}>{error}</div>}

      {!rows.length && (
        <div className="empty">
          Nothing stored yet. The agent writes here as it works: rules it must follow, notes from
          lessons, and what it learns about each site.
        </div>
      )}

      {pinned.length > 0 && (
        <>
          <h3>Pinned — always in context</h3>
          {pinned.map((row) => (
            <Row key={row.id} row={row} onPin={togglePin} onForget={forget} />
          ))}
        </>
      )}

      {rest.length > 0 && (
        <>
          <h3>Stored</h3>
          {rest.map((row) => (
            <Row key={row.id} row={row} onPin={togglePin} onForget={forget} />
          ))}
        </>
      )}
    </div>
  );
}

function Row({
  row,
  onPin,
  onForget,
}: {
  row: Memory;
  onPin: (row: Memory) => void;
  onForget: (row: Memory) => void;
}): React.ReactElement {
  return (
    <div className="card">
      <div className="row spread" style={{ marginBottom: 4 }}>
        <span className="row wrap" style={{ gap: 4 }}>
          <span className="badge">{row.kind}</span>
          <span className="badge">{row.scope}</span>
          {/* Source matters: page-sourced text describes how a site works, it
              never carries authority over the user's own instructions. */}
          <span className="badge" title="Where this came from">
            {row.source}
          </span>
        </span>
        <span className="row" style={{ gap: 4 }}>
          <button className="link small" onClick={() => onPin(row)}>
            {row.pinned ? "unpin" : "pin"}
          </button>
          <button className="link small danger" onClick={() => onForget(row)}>
            forget
          </button>
        </span>
      </div>
      <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{row.text}</div>
      {row.url && (
        <div className="mono dim small" style={{ marginTop: 4, overflowWrap: "anywhere" }}>
          {row.url}
        </div>
      )}
    </div>
  );
}
