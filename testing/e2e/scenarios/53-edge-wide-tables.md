# 53-edge-wide-tables

**Area:** 150- and 1,100-column tables in the UI, the AI and outputs (R10, R11)
**Uses:** `E2E edge sqlite` (`wide_150`, `very_wide_1100`); Postgres, mysql, mssql, snowflake
**Cost:** 2 AI builds
**Requires:** 50

## Steps
1. Workflow `E2E Edge Wide`: Data Source `E2E edge sqlite` / `wide_150`. Open
   Details/schema: all 150 columns are listed, and the panel is usable (scrolls, isn't cut off).
2. Transformer on it: *"Keep only c0001, c0075 and c0150, and only rows where
   c0001 is r3c1 or r4c1."* → **2** rows × **3** columns. Note whether the
   assistant struggled with the width (slow, truncated schema, wrong column names).
3. Outputs from `wide_150` (Truncate & insert): Postgres `e2e_wide_150`, mysql
   `e2e_wide_150` (**R10**: "Row size too large"?), mssql `dbo.e2e_wide_150`,
   snowflake `e2e_wide_150`, and a local Excel file
   `~/Desktop/Sample_data/e2e/edge/out/wide.xlsx`. Record each result.
4. Data Source `very_wide_1100` → Outputs: Postgres `e2e_very_wide` (limit 1,600:
   should pass), mssql `dbo.e2e_very_wide` (**R11**: limit 1,024, should fail
   clearly), local Parquet `…/out/very_wide.parquet`.
5. Transformer on `very_wide_1100`: *"Count the rows."* → **10**. Note whether the
   build fails because the schema is too big for the prompt, and how that's reported.

## Checks
- [ ] Schema panel and preview usable at 150 and 1,100 columns
- [ ] Transformer on 150 columns: 2 × 3 result
- [ ] Every destination loads or fails with a message naming the limit (no generic "insert failed")
- [ ] 1,100-column count: 10, or a clear "too wide" message
- [ ] The app stays responsive throughout
- [ ] No renderer console errors or main-process errors
