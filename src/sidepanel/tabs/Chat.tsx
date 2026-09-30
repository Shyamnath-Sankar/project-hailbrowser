import { useEffect, useRef, useState } from "react";
import type { PanelToWorker } from "../../shared/messages";
import type { Task } from "../../shared/types";
import type { ChatRow } from "../../background/memory/db";
import type { LogLine } from "../usePort";
import { rpc } from "../rpc";

interface Props {
  task: Task | undefined;
  logs: LogLine[];
  send: (msg: PanelToWorker) => void;
  connected: boolean;
}

/** Chat, the ask_human cards, and the composer that starts or steers a task. */
export function Chat({ task, logs, send, connected }: Props): React.ReactElement {
  const [draft, setDraft] = useState("");
  const [history, setHistory] = useState<ChatRow[]>([]);
  const [answer, setAnswer] = useState("");
  const bottom = useRef<HTMLDivElement>(null);

  // Chat history lives in the DB, so reload it whenever the task or its step
  // count changes rather than trying to mirror it in panel state.
  useEffect(() => {
    if (!task) {
      setHistory([]);
      return;
    }
    let live = true;
    void rpc<{ chat: ChatRow[] }>({ kind: "get_task_detail", taskId: task.id })
      .then((d) => {
        if (live) setHistory(d.chat ?? []);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [task?.id, task?.stepCount, task?.status]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [history.length, logs.length, task?.pendingAsk?.id]);

  const submit = (): void => {
    const text = draft.trim();
    if (!text) return;
    if (task && (task.status === "running" || task.status === "planning" || task.status === "paused")) {
      send({ type: "chat", taskId: task.id, text });
    } else {
      send({ type: "start_task", goal: text });
    }
    setDraft("");
  };

  const reply = (value: string): void => {
    if (!task?.pendingAsk || !value.trim()) return;
    send({
      type: "answer_ask",
      taskId: task.id,
      askId: task.pendingAsk.id,
      answer: value.trim(),
    });
    setAnswer("");
  };

  const ask = task?.pendingAsk;
  const idle = !task || ["done", "failed", "cancelled"].includes(task.status);

  return (
    <>
      <div className="pane">
        {!task && (
          <div className="empty">
            <p style={{ marginTop: 0 }}>Tell the agent what to do.</p>
            <p className="small">
              It plans the work, runs it in the current tab, remembers what it learns, and stops to
              ask you when something needs a human.
            </p>
            <p className="small dim">
              Try: &ldquo;Work through the Intro to Statistics course on this site, watch every
              lesson, and stop before any graded quiz.&rdquo;
            </p>
          </div>
        )}

        {history.map((row) => (
          <div key={row.id} className={`msg ${row.role}`}>
            {row.text}
          </div>
        ))}

        {logs.slice(-40).map((line) => (
          <div key={line.id} className={`msg system ${line.level}`}>
            {line.text}
          </div>
        ))}

        {ask && (
          <div className="card ask">
            <div style={{ fontWeight: 600, marginBottom: 6 }}>The agent needs you</div>
            <div style={{ marginBottom: 8, overflowWrap: "anywhere" }}>{ask.question}</div>

            {ask.kind === "login" || ask.kind === "otp" || ask.kind === "captcha" ? (
              <div className="small dim" style={{ marginBottom: 8 }}>
                Do it yourself in the tab, then tell the agent to continue. The task stays saved
                while it waits, so there is no rush.
              </div>
            ) : null}

            <div className="row wrap">
              {(ask.options ?? []).map((option) => (
                <button key={option} className="primary" onClick={() => reply(option)}>
                  {option}
                </button>
              ))}
              {!ask.options?.length && (
                <>
                  <input
                    className="grow"
                    value={answer}
                    placeholder="Your answer"
                    onChange={(e) => setAnswer(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") reply(answer);
                    }}
                  />
                  <button className="primary" onClick={() => reply(answer)} disabled={!answer.trim()}>
                    Send
                  </button>
                </>
              )}
              {/* The wording here is parsed by the worker. "done, continue" read as
                  plain assent, which let the agent redo the very action the human
                  had just performed by hand. */}
              {(ask.options?.length ?? 0) > 0 && (
                <button onClick={() => reply("I handled it myself, continue")}>
                  I handled it, continue
                </button>
              )}
            </div>
          </div>
        )}

        <div ref={bottom} />
      </div>

      <div className="composer">
        <textarea
          className="grow"
          value={draft}
          placeholder={idle ? "What should the agent do?" : "Steer the agent mid-task..."}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <button className="primary" onClick={submit} disabled={!draft.trim() || !connected}>
          {idle ? "Start" : "Send"}
        </button>
      </div>
    </>
  );
}
