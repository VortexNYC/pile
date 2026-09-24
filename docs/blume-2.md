# Blume 2.0 — upgrade readout

Blume 2.0 shipped 2026-09-24. We run `blume ^1.6.0` in `packages/docs` with the config in `packages/docs/blume.config.ts`. This is the delta and what we should actually take.

## Breaking changes that touch us

- **`ai` → `agents`.** Machine-readable settings (`llmsTxt`, `mcp`) moved to a top-level `agents` key. Our config renames the key; flags carry over.
- **Adapter-based architecture.** Search, deployment, content sources, API references, analytics, and Ask AI are now imported adapters. `openapi.sources` stays conceptually the same but plugs into the adapter model; `deployment` becomes an imported adapter from the deployment namespace.
- **Config shape cleanups**: `theme.layout` removed (we don't use it), `markdown.codeBlocks` merged into `markdown.code` (we don't use it), `lastModified` is a flat value, `analytics` is now an array of `blume/analytics` adapters.
- **Stricter CLI**: unknown/misspelled flags now error with suggestions.
- **Component overrides** are statically planned and validated at build time — overrides that don't resolve fail the build instead of silently not rendering.
- `blume upgrade` codemod exists (optional `--claude`/`--codex` agent-assist flags). AsyncAPI support became an optional peer dep.

## New capabilities and whether we want them

| Feature | Verdict | Why |
|---|---|---|
| `llms.txt` + `llms-full.txt` | **Adopt** | Already on via our config; 2.0 makes it first-class. Agents reading docs is our whole story. |
| Raw Markdown at `.md` URLs | **Adopt** | Free agent-consumable docs; zero work beyond upgrade. |
| `blume eval` | **Adopt** | Tests whether an agent can answer questions using only our docs. That's a regression gate for the agent-native claim — add evals for "how do I pull ticket artifacts" / "how do I drive the widget protocol headless". |
| Hosted docs MCP server | **Evaluate** | We already run our own MCP at `pile.nyc`. Docs-MCP would expose docs *content* to agents — different surface, possibly complementary. Don't duplicate tool surfaces. |
| Ask AI adapters (`gateway`, `openrouter`, `openaiCompatible`, …) | **Skip for now** | Token spend on doc Q&A competes with our own MCP/agent surfaces; revisit only if docs-search questions are actually failing. |
| Analytics adapters | **Skip** | Minimalism — no analytics until we need funnel data on docs. |
| Content-derived navigation | **Adopt** | Removes hand-maintained nav drift. |
| Migration from Mintlify/Docusaurus/etc. | N/A | We're already on Blume. |

## Recommended path

1. `pnpm -C packages/docs add blume@^2` then `blume upgrade` in `packages/docs`.
2. Rename `ai` → `agents` in `blume.config.ts`; move `deployment` and `openapi` to their adapter imports.
3. Verify `llms.txt`, `llms-full.txt`, and `.md` routes on `docs.pile.nyc` after deploy.
4. Add a small `blume eval` question set covering the agent surfaces (artifacts endpoint, widget headless protocol, `agent context pull`).
5. Defer hosted docs-MCP and Ask AI until there's a concrete gap.

No urgency to upgrade today — 1.6 works and nothing in 2.0 is a security fix — but the migration is small (one config file) and `blume eval` + raw Markdown are directly on-mission. Bundle it with the next docs change rather than a standalone PR.
