import type { PlanNode } from "../../shared/types";

const MARK: Record<PlanNode["status"], string> = {
  done: "[x]",
  active: "[>]",
  todo: "[ ]",
  skipped: "[-]",
  failed: "[!]",
};

/** The plan tree, so you can see exactly where a long task has got to. */
export function Plan({ nodes }: { nodes: PlanNode[] }): React.ReactElement {
  if (!nodes.length) {
    return (
      <div className="pane">
        <div className="empty">
          No plan yet. The planner builds one when a task starts, and repairs it if the work turns
          out to be shaped differently.
        </div>
      </div>
    );
  }

  const byParent = new Map<string | null, PlanNode[]>();
  for (const node of nodes) {
    const list = byParent.get(node.parentId) ?? [];
    list.push(node);
    byParent.set(node.parentId, list);
  }

  const rows: React.ReactElement[] = [];
  const walk = (parentId: string | null, depth: number): void => {
    for (const node of (byParent.get(parentId) ?? []).sort((a, b) => a.order - b.order)) {
      rows.push(
        <div
          key={node.id}
          className={`node ${node.status}`}
          style={{ marginLeft: depth * 14 }}
          title={node.note ?? undefined}
        >
          <span className="mark">{MARK[node.status]}</span>
          <span className="title">
            {node.title}
            {node.graded && <span className="badge" style={{ marginLeft: 6 }}>graded</span>}
          </span>
        </div>,
      );
      walk(node.id, depth + 1);
    }
  };
  walk(null, 0);

  const done = nodes.filter((n) => n.status === "done").length;
  const skipped = nodes.filter((n) => n.status === "skipped").length;

  return (
    <div className="pane">
      <div className="row spread" style={{ marginBottom: 8 }}>
        <h2>Plan</h2>
        <span className="small dim">
          {done} done{skipped ? `, ${skipped} skipped` : ""} of {nodes.length}
        </span>
      </div>
      {rows}
    </div>
  );
}
