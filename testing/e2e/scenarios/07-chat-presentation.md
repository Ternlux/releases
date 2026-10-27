# 07-chat-presentation

**Area:** chat assistant (analyst) — presentation skill (`build_presentation`)
**Uses:** `products`, `products_store`, `stores`, `employees`
**Cost:** ~10 chat messages, three generated analyses (two run)

## Ground truth
Computed from the CSVs in `~/Desktop/Sample_data` (see also `_DATASET.md`):
- `products`: 30 rows; average price **84.50**; max 149.77, min 24.87 (both "White T-Shirt").
- Price bands: under 50 **7**, 50–100 **11**, over 100 **12**.
- `products_store`: **108** listings — ST-001 15, ST-002 20, ST-003 29, ST-004 14, ST-005 30;
  Phoenix **88**, Los Angeles **20**.
- Catalog value (sum of price over listings): total **9079.25**; Phoenix **7439.05**,
  Los Angeles **1640.20**; per store ST-001 1349.87, ST-002 1640.20, ST-003 2397.47,
  ST-004 1156.57, ST-005 2535.14.
- `employees`: 20 — ST-001 4, ST-002 2, ST-003 3, ST-004 6, ST-005 5; Phoenix **18**, Los Angeles **2**.
- `stores`: 5 (4 Phoenix, 1 Los Angeles).

## Steps
Start a new chat session. Note answer times.
1. **Not a presentation.** *"How many product listings does each store have? Show it as a chart."*
   This is an ordinary question. Expect an inline answer and chart, with no presentation and no clarifying questions.
2. **Clarify first.** *"Build me a presentation on our store inventory and product pricing."*
   Expect clarifying questions and no code. Note whether the questions make sense
   for these connections.
3. **Decline.** Answer: *"Use the products, products_store and stores connections. Focus on
   listings per store and location, price bands (under 50, 50–100, over 100) and catalog value
   per store. Audience: store managers."* Expect an approval panel with the analysis code.
   Read the code: it should be read-only and use the named connections. **Decline** it.
   Expect "Code not run" and no presentation.
4. **Approve.** Repeat the request: *"Build that presentation again, same answers."* Answer any
   questions with the same facts. **Approve** the code. Expect a presentation card in the reply.
5. **Open it.** Check the KPIs, charts, narrative and insights against the ground truth. Every
   chart should render, and no number may contradict the data.
6. **Present mode.** Open Present, move with the arrow keys and the buttons, check the slide
   counter, then Esc out.
7. **Persistence.** Close the viewer, switch to another chat session and back (or reload). The
   card is still there and opens with the same numbers.
8. **Change it.** *"Add a section on employees per store and location to that presentation."*
   Expect it to rebuild: questions, then approval. Approve. The new presentation includes
   employees 18 / 2.
9. 👤 **Export PDF** from the viewer: the user picks the save location in the native dialog.
   The PDF has the dashboard only, in landscape, with charts.

## Checks
- [ ] Q1 answered inline (Phoenix 88 / LA 20 or per-store 15/20/29/14/30), with no presentation card and no presentation questions.
- [ ] Q2 asked clarifying questions before any code; no approval panel on that turn.
- [ ] Declined code produced no presentation and nothing ran.
- [ ] Approved run produced a presentation card (title, KPIs, section count).
- [ ] KPI and chart numbers match the ground truth (products 30, listings 108, avg 84.50, bands 7/11/12, value 9079.25 / 7439.05 / 1640.20).
- [ ] Narrative and insights contain no figures that contradict the data.
- [ ] Every visual renders (no blank or "No data" tiles unless the data really is empty).
- [ ] Present mode: arrows and buttons work, counter right, Esc exits.
- [ ] Card persists across switching sessions and opens with the same data.
- [ ] Change request rebuilds via questions → approval and includes employees 18/2.
- [ ] 👤 PDF export writes a landscape PDF of the dashboard.
- [ ] Generated code is read-only and asked for approval each time.
- [ ] No renderer console errors or main-process errors.

## Cleanup
Leave the chat session.
