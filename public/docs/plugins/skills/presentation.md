# Presentation skill

A **chat** skill: the main chat assistant uses it to turn saved data into a
dashboard presentation of headline numbers, charts and written findings.
Node builders never see it. Transformer and Join nodes cannot pick it, and
the workflow builder does not offer it.

## When the assistant uses it

Only when you explicitly ask for a presentation, dashboard, report or deck.
For an ordinary question you get a normal answer, with charts inline when
they help.

## How a presentation is made

1. **Questions first.** Before any code is written, the assistant asks you
   2–5 questions: which data, which metrics, the time range, the breakdowns
   and the audience. Where there is an obvious default, it suggests one so
   you can just confirm.
2. **One analysis function, which you approve.** From your answers, the
   [JavaScript Executor](javascript-executor.md) writes one function that
   reads your connections and returns named datasets: totals, trends,
   breakdowns, top-N lists. As with any generated code in the chat, you see
   the code and approve it before it runs. It runs **read-only** (a query
   that would change data is blocked) and saves nothing.
3. **The write-up.** The datasets go to one more AI call, which writes the
   title, an executive summary, the headline numbers and the sections. Each
   chart names a dataset and its columns, so the numbers on a chart come
   from the data, not from the model. Where the data cannot answer part of
   the request, the section says so.

The analysis runs once per presentation. To change one, ask for the change.
The assistant builds the presentation again, which means a new round of
questions and a new approval.

## What you get

A card in the chat with the title and a few headline numbers. **Open
presentation** shows it full-screen:

- **Dashboard.** The executive summary and headline numbers, then each
  section's narrative, key insights and charts in a grid.
- **Present.** The cover first, then one section per screen. Use the arrow
  keys to move and Esc to leave.
- **Export PDF.** Saves the dashboard as a landscape PDF, one section per
  page.

Chart types: bar, horizontal bar, stacked bar, line, area, pie, doughnut,
scatter and table. Above six series (three for scatter) or six slices, the
rest are grouped as "Other".

There is no fixed size. A presentation usually has 4–8 sections with 1–3
charts each, and can have more when the request needs it.

The presentation, including its data, is saved with the chat. Reopening it
later shows the same numbers and does not run the analysis again.

## Requirements

The JavaScript Executor skill must be installed. The analysis can read any
saved connection the chat can read.
