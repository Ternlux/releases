# Presentation skill

Builds a dashboard-style presentation from saved data. It is a **chat** skill: the
main chat assistant uses it through the `build_presentation` tool, and only when
the user explicitly asks for a presentation, dashboard or report. Transformer and
Join nodes never see it.

## Flow

1. **Clarify** — `build_presentation { request }` asks the user 2–5 questions
   (data source, metrics, time range, breakdowns). No code is written yet.
2. **Analyse** — `build_presentation { request, answers }` has the
   `javascript-executor` skill write one `transform(records, ctx)` function that
   returns named datasets. The user reads and approves it, exactly like
   `run_javascript`. It runs with the same read-only `ctx`.
3. **Write** — the datasets go to one AI call that writes the title, summary,
   KPIs and sections. Visuals name a dataset and its columns, so chart numbers
   come from the data, not the model.

The chat shows a card; **Open** shows the full-screen dashboard, with a Present
mode (one section per screen) and PDF export.

Requires the `javascript-executor` skill.
