# Skills

Central repository for personal Codex skills.

Each top-level directory is one installable skill. The repository root is only for catalog metadata, shared docs, and repo-level files such as this README, `.gitignore`, and `LICENSE`.

## Catalog

| Skill | Purpose |
| --- | --- |
| [`codex-workflow-runner`](codex-workflow-runner/) | Execute, inspect, and prototype Codex dynamic workflow scripts. |

## Layout

```text
.
|-- README.md
|-- LICENSE
|-- .gitignore
`-- skill-name/
    |-- SKILL.md
    |-- agents/
    |   `-- openai.yaml
    |-- scripts/
    |-- references/
    `-- assets/
```

Only `SKILL.md` is required inside a skill. Add `agents/`, `scripts/`, `references/`, and `assets/` only when the skill needs them.

## Add A Skill

1. Create a new top-level folder named after the skill, for example `my-skill/`.
2. Add `my-skill/SKILL.md` with `name` and `description` frontmatter.
3. Put deterministic helper programs in `my-skill/scripts/`.
4. Put long, load-on-demand docs in `my-skill/references/`.
5. Put templates, images, or other output assets in `my-skill/assets/`.
6. Add or refresh `my-skill/agents/openai.yaml` when the skill should appear nicely in Codex UI surfaces.
7. Add the skill to the catalog table above.

Avoid per-skill READMEs unless a tool specifically requires one; skill instructions should live in `SKILL.md`, with larger supporting material in `references/`.

## Install

Use Vercel's open source `skills` CLI:

```bash
npx skills add rul3rst4/skills --list
```

Install one skill globally for Codex:

```bash
npx skills add rul3rst4/skills \
  --skill codex-workflow-runner \
  --agent codex \
  --global
```

Install all skills from this repository globally for Codex:

```bash
npx skills add rul3rst4/skills \
  --skill '*' \
  --agent codex \
  --global
```

Install into the current project instead of globally by omitting `--global`:

```bash
npx skills add rul3rst4/skills \
  --skill codex-workflow-runner \
  --agent codex
```

For a non-interactive install, add `--yes`:

```bash
npx skills add rul3rst4/skills \
  --skill codex-workflow-runner \
  --agent codex \
  --global \
  --yes
```

The CLI supports GitHub shorthand (`owner/repo`), full GitHub URLs, direct paths to a skill folder, and local paths:

```bash
npx skills add https://github.com/rul3rst4/skills --skill codex-workflow-runner --agent codex --global
npx skills add ./skills --skill codex-workflow-runner --agent codex
```

By default, the CLI offers symlink-based installs where supported. Use `--copy` when you need independent copied files instead.

Useful maintenance commands:

```bash
npx skills list --global --agent codex
npx skills update --global codex-workflow-runner
npx skills remove --global --agent codex codex-workflow-runner
```
