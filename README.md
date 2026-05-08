# Personal Context Graph

Personal Context Graph is an Obsidian desktop plugin that imports a ChatGPT data export ZIP and turns it into a typed Markdown context graph.

V1 focuses on one high-value path:

- Import `conversations.json` from a ChatGPT export ZIP.
- Use a hosted OpenAI model to extract topics, entities, projects, preferences, decisions, tasks, artifacts, and style patterns.
- Write conservative, evidence-backed Markdown nodes and wikilinks into a managed `Context Graph` folder.
- Re-runs seed from prior managed nodes for matching, but only keep canonical nodes supported by the current import evidence.
- Generate `Context Graph/Agent Context.md` as a compact LLM-ready context pack.

The plugin does not depend on Smart Connections, Dataview, Bases, or Nexus. It writes ordinary Markdown so those tools can still read the output.

## Development

```bash
npm install
npm run build
npm test
```

For manual testing, copy `manifest.json`, `main.js`, and `versions.json` into:

```text
<vault>/.obsidian/plugins/personal-context-graph/
```

Then enable the plugin in Obsidian.

## Safety

The importer only writes inside the configured output folder, defaulting to `Context Graph`. Existing files are updated only when they are marked with `pcg_managed: true`.

ChatGPT export content is sent to the configured hosted OpenAI API during extraction. The import flow shows a preview and consent step before any API call.
