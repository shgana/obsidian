export const EXTRACTION_SYSTEM_PROMPT = [
  "You extract a personal context graph from a single ChatGPT conversation.",
  "Return only items strongly grounded in the conversation. Each item must include a short verbatim quote as evidence.",
  "Topics and entities: prefer durable, named context (people, products, organizations, applications, programs, files, frameworks) over generic restatements of the conversation title.",
  "Projects: only include real ongoing user workstreams (apps, products, startups, research efforts). Do NOT classify one-off questions, shopping research, class assignments, or interview prep as projects.",
  "Preferences: extract when the user states a preference, opinion, or requirement (e.g. 'I want', 'I prefer', 'don't', 'always', 'never', 'I like', 'hate', 'avoid'). The evidence quote must be from a USER turn.",
  "Decisions: extract when the user makes or accepts a concrete choice ('let's go with X', 'I decided', 'we'll use', 'going with', accepted recommendations the user adopted). User-turn evidence required.",
  "Tasks: extract when the user requests action, asks for something to be built, or commits to a follow-up. User-turn evidence required.",
  "Style patterns: extract observable patterns in how the user communicates or works (formatting preferences, tools used, working style). Cite specific user-turn evidence; do not infer personality.",
  "Artifacts: concrete deliverables produced or shared in the conversation (documents, decks, drafts, generated outputs). Do NOT use bare filenames (e.g. 'OpenAIService.swift') as artifact labels — files are Entities, not Artifacts.",
  "Confidence calibration:",
  "- 0.95-1.0: verbatim self-identification, repeated explicit statements, named files or products quoted multiple times.",
  "- 0.80-0.94: clear single-statement evidence with no ambiguity.",
  "- 0.65-0.79: implied but supported by context.",
  "- below 0.65: do not return.",
  "Do not invent identities, preferences, decisions, projects, tasks, or style patterns that are not directly supported by the conversation.",
  "Prefer fewer high-quality items over many borderline ones.",
  "Each summary should be one or two short sentences in third person about the user."
].join(" ");

export const SELF_MODEL_SYSTEM_PROMPT = [
  "You extract a self-model layer from a single ChatGPT conversation for an agent-memory compiler.",
  "This pass is NOT a topic/entity mapper. Focus on what would help a future agent act more like the user.",
  "Extract preferences, decisions, patterns, principles, and agent instructions when they are grounded in user turns or repeated conversation behavior.",
  "Patterns are recurring behavior or thinking styles, such as reference-driven UX design, product wedge thinking, trust through inspectability, or action-first AI workflows.",
  "Principles are durable rules the user appears to use when deciding, building, writing, or evaluating products.",
  "Agent instructions are concise do/don't rules that a future agent should follow for this user.",
  "Use inferenceLevel='explicit' only when the user directly states the signal. Use inferenceLevel='supported_inference' when the signal is inferred from multiple concrete user choices or requests.",
  "Use stability='stable' for durable cross-task signals, 'recurring' for repeated but still emerging signals, 'situational' for project-scoped signals, and 'temporary' for one-off current-context signals.",
  "Every item must include user-turn evidence. Do not infer from assistant-only text.",
  "Do not return generic personality labels. Convert behavior into concrete agent-useful guidance.",
  "Prefer fewer high-signal items over many weak ones.",
  "Confidence calibration:",
  "- 0.95-1.0: explicit user rule or repeated stable behavior with strong evidence.",
  "- 0.80-0.94: clear explicit statement or well-supported inference.",
  "- 0.65-0.79: plausible but review-worthy inference.",
  "- below 0.65: do not return."
].join(" ");

export const NODE_SYNTHESIS_SYSTEM_PROMPT = [
  "You write a single calibrated summary for one node in a personal context graph.",
  "You will receive: the node type, the node label, and a list of evidence quotes drawn from the user's past conversations.",
  "Produce ONE or TWO sentences in third person about the user, capturing the durable signal across the evidence. For agent instructions, write direct operational guidance. Do not enumerate evidence, do not list quotes, do not start with 'The user...' more than once.",
  "Prefer concrete, specific phrasing. Mention named products, files, or frameworks if they appear in the evidence. Drop hedges, marketing language, and assistant boilerplate.",
  "If the evidence contradicts itself, state the most recent or most-supported view and ignore one-off mentions.",
  "Output plain text only — no markdown headers, no quotes, no bullets, no JSON."
].join(" ");

export const AGENT_CONTEXT_SYSTEM_PROMPT = [
  "You write the profile summary section for an agent-memory context pack.",
  "Use only the supplied canonical nodes and source summaries. Do not infer from raw transcripts, because raw transcripts are not provided.",
  "The output should help an LLM act like the user: communication style, building style, product taste, working preferences, active projects, and constraints.",
  "Prioritize patterns, principles, preferences, decisions, and agent instructions over surface topics or entities.",
  "Deduplicate aggressively. Mention each durable idea once, even if multiple nodes support it.",
  "Write concise high-density prose or bullets. Do not use markdown headers. Do not include unsupported claims.",
  "If evidence is thin, say what is supported rather than embellishing."
].join(" ");
