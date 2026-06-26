# HTML output house style

**When you generate an HTML file** — artifact, report, plan, itinerary, guide, brainstorm,
dashboard, mockup, code review, or anything else — follow this house style unless the user
explicitly asks for a different look. It makes output look designed and editorial instead of
like default framework output.

Why it matters: with no constraints, HTML drifts to a generic default (pure white, cold
gray, blue links, heavy drop-shadows, full-bleed width). Everything below is a small,
opinionated system that avoids exactly that. Apply all of it — not just the palette.

---

## The rules (the "anti-slop" checklist)

**Single file, hand-crafted look.** One ready-to-open `.html` file, no build step. Write your
own CSS in one `<style>` block; don't use CSS frameworks or UI kits (Tailwind, Bootstrap,
Material) — they drag the look back to generic defaults. System fonts by default. Functional
libraries from a pinned CDN (charts, maps, 3D, diagrams) are welcome when they make the artifact
richer — but the *visual* layer stays yours, styled to this palette.

**Warm, not cold.** Never pure white pages or pure black text.
- Page background = warm ivory `#FAF9F5` (white `#FFFFFF` is only for raised cards on top)
- Text = warm near-black `#141413` (never `#000`)
- Grays are warm-tinted (`#87867F`, `#3D3D3A`), never cold `#888`
- Exactly **one** accent color (clay/terracotta `#D97757`), used sparingly

**Three type roles, system fonts:**
- `--serif: ui-serif, Georgia, serif` → display + headings
- `--sans: system-ui, -apple-system, sans-serif` → body + UI
- `--mono: ui-monospace, 'SF Mono', Menlo, monospace` → code + micro-labels

**Editorial typography:**
- Headings are **serif, medium weight (500 — NOT bold 700)**, with tight negative
  letter-spacing (`-0.01em` to `-0.02em`)
- Body ~15–16px, line-height 1.5–1.55
- Eyebrows / micro-labels: mono, ~11px, UPPERCASE, `letter-spacing: 0.08em`, gray-500

**Flat, bordered — not floaty.** Separate things with **1px / 1.5px hairline borders**,
not drop-shadows. Shadows are rare and barely visible when used (`0 1px 2px rgba(20,20,19,.06)`).
Reserve a soft shadow only for genuinely floating things (popovers).

**Restrained shape language:** radius 8px (rows/buttons), 12px (panels/cards),
999px (pills/tags), 50% (avatars/status dots).

**Width follows the content.** *Prose* lives in a centered `max-width: 640–760px` column —
don't stretch running text full-bleed. But rich, visual, or interactive artifacts (dashboards,
galleries, comparisons, maps, timelines, boards) should take whatever width the subject needs:
go wider, multi-column, or full-bleed. Keep the warm base, hairline borders, and type craft as
you do — width is a layout choice, not a license to drop the house style.

**Color-coded semantics as tinted pills.** success=olive `#788C5D`, warning=amber `#C78E3F`,
danger=rust `#B04A4A`, info=slate-blue `#5C7CA3`. Render as badges with a *translucent* tint
of the color (`rgba(...,0.14)` background + solid color text), not loud solid fills.

**Polish details:** `box-sizing: border-box` everywhere · `-webkit-font-smoothing: antialiased`
· `transition: …0.12s ease` on interactive elements · accent-tinted focus ring
(`box-shadow: 0 0 0 3px rgba(217,119,87,0.15)`) · generous section spacing (48–64px).

---

## Drop-in token + base block

Start every HTML file from this block. Use these exact tokens unless the user gives you
their own palette; keep the *structure* either way.

```css
:root{
  /* warm base */
  --ivory:#FAF9F5; --slate:#141413; --white:#FFFFFF;
  --gray-100:#F0EEE6; --gray-300:#D1CFC5; --gray-500:#87867F; --gray-700:#3D3D3A;
  /* one accent */
  --clay:#D97757; --oat:#E3DACC;
  /* semantics */
  --success:#788C5D; --warning:#C78E3F; --danger:#B04A4A; --info:#5C7CA3;
  /* type */
  --serif:ui-serif,Georgia,'Times New Roman',serif;
  --sans:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;
  --mono:ui-monospace,'SF Mono',Menlo,Monaco,monospace;
  /* shape */
  --radius-row:8px; --radius-panel:12px; --border:1.5px solid var(--gray-300);
}
*{box-sizing:border-box}
body{
  margin:0; padding:56px 24px 96px; background:var(--ivory); color:var(--slate);
  font-family:var(--sans); font-size:15px; line-height:1.55;
  -webkit-font-smoothing:antialiased;
}
.page{max-width:760px;margin:0 auto}                 /* reading column — widen/replace for visual or interactive layouts */
h1,h2,h3{font-family:var(--serif);font-weight:500;letter-spacing:-0.01em;margin:0 0 8px}
h1{font-size:40px} h2{font-size:26px} h3{font-size:20px}
.eyebrow{font-family:var(--mono);font-size:11px;text-transform:uppercase;
  letter-spacing:.08em;color:var(--gray-500)}
.card{background:var(--white);border:var(--border);border-radius:var(--radius-panel);padding:24px}
code,.mono{font-family:var(--mono);font-size:13px;background:var(--gray-100);
  padding:1px 5px;border-radius:4px}
.badge{display:inline-flex;align-items:center;height:22px;padding:0 9px;font-size:12px;
  font-weight:500;border-radius:999px}
.badge.accent{background:rgba(217,119,87,.14);color:var(--clay)}
.badge.ok{background:rgba(120,140,93,.16);color:var(--success)}
.badge.warn{background:rgba(199,142,63,.16);color:#A06A2A}
.btn{display:inline-flex;align-items:center;height:36px;padding:0 16px;font:500 14px var(--sans);
  border-radius:var(--radius-row);border:1.5px solid transparent;cursor:pointer;
  transition:background .12s ease,border-color .12s ease}
.btn.primary{background:var(--clay);color:#fff}
.btn.secondary{background:#fff;color:var(--slate);border-color:var(--gray-300)}
```

---

## Approach

Favor **outcome + latitude**: design the ideal interface for the user's actual problem,
not a minimal page. Pack in whatever the subject needs — visuals, mockups, data, excerpts,
interaction — to give the reader maximum context at a glance. Make sensible layout decisions
on your own instead of asking.

This file is self-sufficient: the token block above is enough to produce the look on its
own. If a `design-system.html` reference is also present, mirror its components exactly.
