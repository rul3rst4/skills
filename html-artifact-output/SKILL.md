---
name: html-artifact-output
description: Design rich, self-contained, interactive HTML artifacts that bring an idea to life for ANY subject — technical or not — choosing the ideal interface for the subject and packing it with fitting visualizations, mockups, diagrams, data views, timelines, maps, and interactive controls, all styled with the bundled warm editorial design kit. Use whenever the user wants to visualize, explain, plan, compare, brainstorm, or present something as an HTML artifact/page/report/output — e.g. a trip itinerary or travel guide, a product or feature brainstorm, a buying guide or comparison, a learning explainer, a dashboard, a project summary, an implementation plan, a code review, a mockup, or a pitch.
---

# HTML Artifact Output

## What this skill is for

Turn anything the user is thinking about into a polished, self-contained HTML file they can open and immediately *get*. The subject can be anything — a weekend in Lisbon, a SaaS pricing model, a product roadmap, a code review, a comparison of three cameras, a lesson on photosynthesis, a fundraising pitch. The output is always a single beautiful HTML artifact designed around that specific subject.

## Core philosophy

**Every artifact should be rich, and you should design the ideal interface for the problem at hand.** Don't produce a minimal document or a wall of text. Think like a designer who has been handed this exact subject and asked to make it come alive:

- **Rich by default.** Lead with visuals, structure, and interaction — not paragraphs. Show the idea; don't just describe it.
- **Designed for the subject.** A travel itinerary is not a code review is not a product brainstorm. Each deserves its own information architecture, its own components, its own interactions. Invent the layout the subject is asking for.
- **Make it come to life.** Use mockups, diagrams, timelines, maps, charts, comparisons, calculators, filters, toggles, small simulations and anything else to turn an idea into something the user can explore and feel.
- **Maximum useful context at a glance.** Pack in the things that help the user decide, understand, or imagine — and cut anything that is just noise.

You have wide latitude. Make confident design and layout decisions on your own instead of asking. When you are unsure what would help most, err toward richer and more visual.

## Designing the interface is the creative act

This is the heart of the skill. There is no default layout, no standard set of sections, no catalog of patterns to choose from. Every subject gets an interface invented for it, from scratch. **Start from the subject in front of you, never from a familiar format.**

Work it like a designer:

- **Find the subject's natural shape.** What is it really about? What does the user want to do with it — decide, plan, learn, pitch, explore, remember? What single view would make it click?
- **Let the structure emerge from the content.** A process wants a flow; a set of options wants a weighing; a place wants a map and a sense of time; an argument wants evidence in tension; a system wants to be seen working. Discover the structure the subject is already asking for instead of imposing one on it.
- **Choose components and interactions in service of that structure — then build whatever is missing.** If the ideal interface needs something that doesn't exist yet, invent it.
- **Reach for the unexpected when it serves the idea.** The most memorable artifact is often one the user wouldn't have known to ask for.

Don't anchor on any familiar format, and don't reuse a structure just because it worked last time. Two requests that sound alike can deserve completely different interfaces. What matters is not which components you reach for — it is that you designed the right thing for *this* subject.

The building blocks are open-ended: timelines, maps, calculators, comparisons, diagrams, galleries, boards, simulations, dashboards, annotated mockups — and countless things with no name yet. Any such list is only sparks for your imagination, never a menu to pick from or a checklist to complete. Combine, discard, stretch, and invent freely.

To be concrete about how far interfaces should diverge — these are *illustrations, not templates to copy*: a long weekend in Lisbon might become a day-by-day timeline with map pins and a running budget; a pricing-model brainstorm might become plan cards beside a live revenue calculator; a camera buying guide might become a filterable gallery with a scored comparison; a code review might become an architecture diagram with annotated excerpts and a prioritized fix list. Each was derived from its subject. Don't reuse any of them — build the one your subject is asking for.

## The visual foundation (house style)

Before generating, read `references/house-style.md` and apply its full checklist. Use `assets/design-system.html` as the visual reference for components, spacing, type, color, borders, badges, buttons, and inputs.

This warm editorial style is your **craft floor** — it is what keeps every artifact from looking like generic framework slop. Copy the tokens, CSS, and component patterns directly into the output so the file is self-contained; do not link to these files at runtime.

Treat the house style as the default aesthetic, then make it yours for the subject: choose the density, layout, and components that fit, and extend the system with subject-appropriate visualizations. You may shift the palette or mood when the subject or the user genuinely calls for it (a kids' lesson, a specific brand) — but keep the craft principles: warm over cold, flat and bordered over floaty, clear typographic hierarchy, one restrained accent, never slop.

## Output rules

- Always one ready-to-open `.html` file with no build step (unless the user explicitly asks for another format). Default to self-contained: inline your own CSS in a single `<style>` block and your own JS in a single `<script>` block.
- Reach for libraries when they make the artifact genuinely richer or more interactive than you could practically hand-build — charting (Chart.js, D3, Plotly), maps (Leaflet), 3D (Three.js), diagrams (Mermaid), animation, real data viz. Load them from a reputable, version-pinned CDN (jsDelivr, unpkg, cdnjs); keep the set small and well-known, and style their output to the house palette so it still looks like one designed piece.
- Don't use CSS frameworks or UI kits (Tailwind, Bootstrap, Material). They pull the look back toward generic framework defaults — the exact slop the house style exists to avoid. The visual layer stays hand-crafted; system fonts by default.
- If the artifact might be opened offline or in a network-restricted or unknown environment, stay fully self-contained, or make any library optional so the page still works without it.
- Use the warm base, serif headings, hairline borders, restrained radius, and single accent from the house style.
- Make it responsive and readable on both mobile and desktop.
- Prefer accessible, semantic HTML: visible focus states, sufficient contrast, keyboard-friendly controls, and alt text / labels where they matter.
- Add interactivity when it clarifies the subject or brings it to life — whatever form fits best, from a simple toggle to a filter, a calculator, or a small simulation. Keep it smooth and lightweight; never interactive for its own sake.

## Workflow

1. Identify the subject, the audience, and what the user is trying to do with it (decide, plan, learn, pitch, explore, remember).
2. Gather what you need to make it accurate — relevant files, diffs, data, screenshots, command output, or facts about the topic.
3. Design the ideal interface for *this* subject (see "Designing the interface is the creative act"): what is the spine of the layout, what are the key views, and what would the user most want to see, manipulate, or compare?
4. Read `references/house-style.md`; consult `assets/design-system.html` when exact component treatment matters.
5. Generate the HTML file in the current workspace with a descriptive hyphen-case name.
6. Verify it opens as a standalone document. For interactive or visual artifacts, do a browser check when practical.
7. In your reply, link to the file and briefly call out what it contains and how to use any interactive parts.

## Quality bar

The artifact should feel like something a thoughtful designer made for this exact subject: warm, alive, easy to scan, and rich with the right context and interaction. The user should think "oh, this is *exactly* what I wanted to see." Avoid generic white-page framework defaults, walls of text, decorative clutter, recycled layouts, and forcing a structure onto a subject it doesn't fit.
