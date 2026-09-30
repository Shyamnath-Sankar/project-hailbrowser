# Project Browser

A long-horizon browser agent that lives in a Chrome side panel. You type a goal, it plans the work, runs it in your tab, remembers what it learns, and stops to ask you when something needs a human. Bring your own API key.

Built to survive tasks that take hours: the agent's state lives in IndexedDB, not in a chat history, so step 500 costs the same as step 5 and a browser restart doesn't lose the task.

## Install

```bash
npm install
npm run build
```

Then in Chrome: `chrome://extensions` → enable Developer mode → **Load unpacked** → select the `dist/` folder. Click the extension icon to open the side panel.

Configure at least one model under **Settings** before starting a task.

Each of the three jobs — planner, executor, verifier — is a self-contained card holding its **own** provider, model, base URL and key, with its own **Test this model** button that reports the reply, latency and cost right there. So the executor can run against a local endpoint while the planner uses a hosted one, and two roles can point at two *different* OpenAI-compatible servers without colliding.

Leaving a key blank is normal: a role borrows the key from another role on the same provider, so one Anthropic key typed once covers all three. The placeholder tells you where a borrowed value came from.

| Provider | Notes |
|---|---|
| Anthropic, OpenAI, Gemini, OpenRouter | Key only |
| Ollama | Local, no key needed |
| **OpenAI-compatible** | Anything speaking `/chat/completions`: vLLM, LM Studio, llama.cpp, Together, Groq, Fireworks, Azure OpenAI, a company gateway. Paste the base URL up to `/v1` (the rest of the path is appended, and a pasted `/chat/completions` is tolerated); leave the key blank if the endpoint needs none. Azure keys are also sent as `api-key`. |

A model we have no price for shows $0 spend rather than a fabricated number — the step and time budgets still bound the task.

```bash
npm run dev        # rebuild on change
npm run typecheck
npm test
```

## How it works

Three model roles, each with its own slot so you pay for capability only where it matters:

| Role | Runs | Default |
|---|---|---|
| Planner | Once per task, plus on a stuck-replan | `claude-opus-5-5` |
| Executor | Every step | `claude-sonnet-5-5` |
| Verifier | At milestones and before accepting "done" | `claude-haiku-4-5` |

### Seeing the page

A content script indexes every visible interactive element — through shadow DOM and iframes — into a numbered list the model acts on by index:

```
[14] button "Start Quiz"
[15] video (151/760s, playing)
[16] input[radio] "B) Photosynthesis"
```

Text goes on every step. Screenshots (with numbered boxes drawn over the same elements) are sent only when the text isn't enough: a blank page, a repeated failure, a CAPTCHA. That default is the single biggest cost lever. **Settings → Debug** draws those boxes in the page so you can see what the agent sees.

Transient API failures (429, 503, a dropped socket) retry with backoff. A four-hour task will meet one eventually, and losing that work to a blip that clears in two seconds is the worst failure this agent has.

Actions go through the Chrome DevTools Protocol rather than synthetic DOM events, because many sites check `isTrusted` and ignore the latter.

### Each step

The executor returns one JSON object, and the shape is what produces the behavior:

```json
{
  "evaluation_previous_step": "Clicked Next, lesson 2.3 loaded. Success.",
  "memory": "Module 2: 3/5 lessons done. Quiz rules saved.",
  "next_goal": "Play the video and wait for it to end",
  "actions": [
    { "type": "click", "index": 15 },
    { "type": "wait_until", "condition": { "type": "video_ended" }, "timeoutMs": 780000 }
  ]
}
```

Checking its own last step catches failures early. Batching safe actions cuts the number of round trips. `wait_until` polls inside the page, so a 20-minute video costs **zero** model calls while it plays — this is what makes watching a course affordable rather than theoretical.

### Video, specifically

Lesson video is where a course agent spends its wall-clock time, so **skipping to the end is the default** — a 20-minute lesson takes a couple of seconds.

It doesn't work everywhere, and that's the whole design problem. Many platforms track progress with beacons sent *while* a video plays, so a jump to the end sends no intermediate progress and the lesson stays marked unwatched. Some players also refuse to seek past what you've actually watched. A course that merely *looks* finished is the worst outcome, so:

- **The skip plays out the final fraction** rather than hard-setting `currentTime = duration`, because it's the player's `ended` handler that marks most lessons complete, and a hard jump often never fires it.
- **A player that blocks seeking is detected** — via its own `seekable` range, or by catching it yanking the position back — and the agent falls back to real playback for that video on its own.
- **Completion is verified against the page**, not the player. A video element reaching its end isn't proof the platform counted it. If the lesson didn't register, the agent watches it properly and records that the site requires real playback, so later lessons there don't rediscover it.
- **Captions go on either way.** When skipping, the transcript is the only record of what the lesson said — and that's what a later quiz draws on.

Switch to **Watch them through** in settings for strict platforms, or when you'd rather not find out the hard way. That path keeps the playback handling: the wait sizes its own timeout from real remaining duration and speed, a stall (ad, "still watching?" prompt, in-video quiz, buffering failure) returns early after 45s instead of burning the full video length, and an autoplay-forced mute is reported so the agent can unmute if the lesson needs audio.

Speed and stall tolerance only appear in settings when you're watching, since they mean nothing while skipping. Neither strategy costs less money — waiting is already free — the difference is only wall-clock time and risk.

Every action is validated before it runs (`normalizeStep`): unknown types are dropped, a `navigate` to anything but `http(s)` is rejected, and an absurd timeout is capped.

### Memory

The prompt is rebuilt from storage every step and stays roughly constant in size:

```
[Goal] [Plan tree ✅⏳⬜] [Current subtask]
[📌 Pinned instructions]      ← test rules live here
[Recalled notes] [Your live messages]
[Policy] [Loaded skills] [Last ~8 steps] [Page snapshot]
```

Layers: a running scratchpad, task/course/site-scoped memories, and pinned items that appear in every prompt within their scope. When the page classifier sees an `instructions` page, the agent captures the rules and pins them — so "10 questions, 80% to pass, 3 attempts" is still in context when the quiz shows up twenty steps later.

Everything read off a page is stored as `source: page`. Your own words are `source: user`. Page text describes how a site works; it never carries authority over your instructions. The **Memory** tab shows everything stored, and lets you pin, unpin, or delete any of it.

### Skills

Progressive disclosure: only a skill's one-line description sits in the prompt, and the agent calls `load_skill` for the body when it wants it. Built-ins cover `video-lesson`, `reading-lesson`, `instructions-capture`, `quiz`, `course-mapper`, `form-fill`, `login-handoff`, and `captcha-handoff`. You can write your own in the **Skills** tab, scoped by page type and/or host.

### Surviving long runs

- **Checkpoint after every action.** Steps are idempotent, so a resumed task re-reads the page and continues.
- **Watchdog.** Chrome evicts idle MV3 service workers; a `chrome.alarms` tick every minute restarts any task still marked running. This is the difference between an agent that dies at minute 5 and one that finishes.
- **Stuck detector.** Three identical page fingerprints → a warning that forces a different approach. Four → a full replan that preserves completed work.
- **Verifier.** A `done` claim is checked against the page before it's accepted; a rejected claim sends the agent back to work.
- **Budgets.** Dollars, steps, and minutes. Hitting one pauses and asks rather than quitting.

### Stopping for you

`ask_human` covers logins, OTPs, CAPTCHAs, missing information, and anything irreversible. You get a desktop notification, the task waits in storage, and it resumes when you answer — hours later is fine. **Take over** pauses the loop and detaches the debugger so you can drive the tab yourself, then **Resume** hands it back.

Independently of what the model decides, a click on a control labeled like `submit`, `pay`, `delete`, or `send` is gated on confirmation while that policy is on.

## Limitations

Worth knowing before you rely on it:

- **Prompt injection is the real risk.** A page can contain hidden text aimed at your agent. Page content is treated as data and page-sourced memory is marked as such, but this is mitigation, not a solution. Keep confirm-before-submit on.
- **API keys are stored in `chrome.storage.local`**, which is not strongly protected — anything with access to your browser profile directory can read them. Use rotatable keys and set a spend cap with your provider.
- **The debugger banner** ("… is debugging this browser") is shown by Chrome while a task runs and can't be hidden.
- **Some pages are off-limits** to any extension: `chrome://`, the Web Store, PDF viewer. The agent reports this and navigates away rather than looping.
- **Anti-bot measures.** Some sites detect automation; CAPTCHAs become a handoff.
- **Automated test-taking** defaults to asking you first. Many platforms and institutions forbid it — that setting is yours to make deliberately.

## Layout

```
src/
  shared/          types, message envelopes, defaults
  content/         indexer, classifier, media, waiters, extract, overlay
  background/
    orchestrator.ts  task engine: loop, checkpoints, stuck detection, budgets
    context.ts       prompt builder (fixed-size context)
    dispatch.ts      action execution + the irreversible-action gate
    perception.ts    multi-frame snapshot merge
    agents/          planner, executor (+ validation), verifier
    memory/          Dexie schema, store, recall
    llm/             anthropic, openai-compat, gemini + router
    cdp/             CDP input, screenshots
    skills/          built-ins + router
  sidepanel/       React UI: chat, plan, steps, memory, skills, settings
```
