// Every heavy-LLM task key Joyride passes to llm({ task }). llm.tasks overrides
// are looked up by exact key, so a key not listed here never matches a call site
// and silently falls back to llm.default; config load warns about those.
// Add a task here when you add an llm() call with a new task key.
export const LLM_TASKS: Record<string, string> = {
  session_preserve: "Saving session context before closing an idle pane",
  session_intent: "Summarizing what each session is doing",
  mission_naming: "Naming missions from sessions",
  proposal_brief: "Briefing mission proposals",
  screenshot_caption: "Captioning screenshots",
  ask_options: "Suggesting answers for the captain's asks",
  idea_naming: "Naming ideas and placing tasks Jev is unsure about",
  idea_brief: "Writing each idea's headline, now and next",
};

/** llm.tasks keys that no call site uses. */
export const unknownLlmTasks = (tasks: Record<string, unknown> | undefined) => Object.keys(tasks ?? {}).filter((k) => !(k in LLM_TASKS));

export const unknownLlmTasksWarning = (keys: string[]) =>
  `joyride.config.yaml llm.tasks has ${keys.length === 1 ? "a key" : "keys"} no task uses: ${keys.join(", ")}. Those overrides never apply; calls fall back to llm.default. Known tasks: ${Object.keys(LLM_TASKS).join(", ")}.`;
