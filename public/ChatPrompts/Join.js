/** 
 * Chat Prompts for Join Node Configuration
 * Handles intelligent join analysis and query generation
 */

// The one description of ctx.runQuery's vector operations — the same text the
// chat and the javascript-executor are given (see public/lib/vectorQueryGuide).
const { VECTOR_QUERY_GUIDE } = require('../lib/vectorQueryGuide');

const JoinPrompts = {
  /**
   * Analyze join request to determine configuration needs
   *
   * ── Write modes ─────────────────────────────────────────────────────────────
   *
   * Two: "new_table" (replace the target every run) and "append" (keep its
   * rows, add this run's). The old "merge_existing" was removed because the
   * executor never created a missing target in that mode; append now does —
   * every destination checks whether the target exists and runs the CREATE
   * only when it does not, and never drops it. Merge / upsert into a table is
   * still not offered.
   *
   * The `operationMode` parameter stays in the signature only because it is
   * positional; the mode is decided by the model's inferredSettings.
   */
  joinAnalysisRequest: (
    userRequest,
    sourcesInfo,
    availableDestinations,
    operationMode,
    availableSkills = [],
    vectorContext = {}
  ) => `
You are an expert data engineer helping configure a join operation between multiple data sources.

Current User Request: "${userRequest}"

Available Sources:
${sourcesInfo}

Available Destinations:
${availableDestinations}

If the user asks to write the result into a connection under "NOT join destinations", do not pick another destination for them: return "ask_questions" with a followUpQuestion that says that connection cannot receive a join result, names the destination this join writes to now (if one is chosen), and offers the real choices — keep it, a saved database, or local-duckdb (a table in THIS workflow's own database, not that file). A destination is only ever changed to the one the user named.

Current write mode of this join: ${vectorContext.currentMode || 'new_table'}${vectorContext.currentMergeKeys && vectorContext.currentMergeKeys.length ? ` (merge keys: ${vectorContext.currentMergeKeys.join(', ')})` : ''}
${vectorContext.destinationDescription ? `
Destination already chosen: ${vectorContext.destinationDescription}
` : ''}
${(vectorContext.hasVectorSource || vectorContext.hasVectorDestination) ? `
## Vector / embedding context detected
${vectorContext.hasVectorSource ? '- One or more SOURCES are vector databases (LanceDB / Pinecone).\n' : ''}${vectorContext.hasVectorDestination ? '- The DESTINATION is a vector database (LanceDB / Pinecone).\n' : ''}
You MUST decide which scenario applies and report it back via the \`vectorRequired\` flag in your response (true = Scenario B, false = Scenario A or no vector logic). Read the user's request literally — do not assume similarity search just because a vector DB is involved.

**Scenario A — Treat the vector DB as a regular database (\`vectorRequired: false\`).**
The user just wants to read records (id + metadata fields) and join them by equality on a normal key. No embeddings, no similarity search.
- The executor will fetch the vector source via its API (filter / metadata only) and flatten id + metadata into row-shaped objects — from then on treat it exactly like a NoSQL source.
- Right choice for: "join the article rows where category='news'", "read all records from the index", "use the metadata fields to join".

**Scenario B — Similarity search / embedding is part of the join (\`vectorRequired: true\`).**
The user wants embeddings or similarity search to participate in the join logic itself: "find rows similar to …", "for each customer match the most relevant article", "embed this column and upsert", "vectorize the bio column", "semantic match on the description".
- The actual embedding + similarity-search code runs **locally in Node**, inside an async \`javascriptFunction\` you'll emit at the next step. The function uses \`ctx.vectorize(texts, ...)\` to embed and \`ctx.runQuery(connection, { operation: 'queryVectors', queryVector, topK }, dbPath?)\` to search the vector source — per row, ad hoc, no SQL needed.
- Once the function returns, the executor inserts the rows it returned into the destination. The destination DB does NO compute here — it is only the place the final rows get written.
- This means **every destination is valid for Scenario B** — MongoDB, a local vector table, a local table, or a SQL database — even though none of them can embed from SQL. For a table destination the returned rows are simply written as the table. **Do NOT ask the user to pick Postgres+pgvector / Snowflake / "a vector engine that can run the embedding"** — none of that matters; the embedding and search happen in the function before insert.
- Do not try to express the embedding/search as a fixed SQL search query or a one-shot \`searchQuery\` — emit a \`javascriptFunction\` instead.
- Confirm with the user only what's actually needed for their intent: which column to embed / search by, which vector source to query, an embedding provider/model if there's a choice, and the desired \`topK\`. Do not ask the user to change the destination for this — any destination works.

Always handle vector cases inline — set \`usesSkill: false\`.
` : `
## Vector context
No vector source or destination is configured. If the user asks for embeddings, similarity search, or vectorising a column, set \`vectorRequired: true\`. The embedding / similarity-search code runs locally in Node inside the \`javascriptFunction\` (using \`ctx.vectorize\` and \`ctx.runQuery\`), and the destination DB is only used to store the final rows — so any destination is fine: Mongo, a vector store, a local table or a SQL database. Do NOT ask the user to switch destinations, or to a SQL engine that can "execute embeddings" — that's not how this runs. If neither vector source nor destination is configured and the user does NOT mention embeddings/similarity, leave \`vectorRequired\` as false.
`}
${availableSkills.length > 0 ? `**Available Skills**:
You have access to these special join skills that can be used instead of standard SQL/NoSQL joins:

${availableSkills.map(skill => `
**${skill.name}** (${skill.id}):
${skill.description.description}

Capabilities:
${skill.description.capabilities.map(cap => `- ${cap}`).join('\n')}

${skill.prompts ? skill.prompts.systemContext : ''}
`).join('\n')}

**IMPORTANT**: If a skill is better suited for the join operation than standard SQL/NoSQL, you can specify "usesSkill": true and "skillId": "<skill-id>" in your response.
` : ''}

Analyze the user's request and conversation history to determine the next steps. Return JSON with the following structure:
{
  "action": "ask_questions" | "generate_join",
  "usesSkill": false | true,
  "skillId": "skill-id-here (only if usesSkill is true)",
  "skillExplanation": "Brief explanation of why this skill is being used (only if usesSkill is true)",
  "vectorRequired": false | true,   // true ONLY when this join needs runtime embedding / similarity search (Scenario B). Defaults to false. Read the user's intent — a vector source on its own does NOT imply vectorRequired.
  "requiresFunction": false | true,   // is this join a JavaScript function instead of SQL? ALWAYS true for a MongoDB or vector destination, and whenever vectorRequired is true. For a SQL database or local-duckdb destination, decide by rule 5c. Defaults to false.
  "inferredSettings": {
    "destinationSelection": "connection_id or local-duckdb or local-lancedb",   // optional; use local-lancedb when the user wants the result stored as a LOCAL vector table — embeddings / a lancedb table / similarity-searchable — and named no saved vector connection. Do NOT downgrade a requested local vector table to local-duckdb
    "operationMode": "new_table" | "append" | "merge",   // new_table (default) replaces the target every run; append keeps its rows and adds this run's; merge updates the rows that match on mergeKeys and inserts the rest — see rule 1
    "mergeKeys": ["col"],   // ONLY with "merge": the output column(s) that identify a row
    "targetTableName": "table_name",   // REQUIRED
    "selectedColumns": {"sourceLabel1": ["col1", "col2"], "sourceLabel2": ["col3"]}   // optional; "*" as the only entry for a source means ALL of that source's columns — see below
  },
  "followUpQuestion": "Single clear question to ask the user",   // only if action is "ask_questions"
  "reasoning": "explanation of decision"
}

CRITICAL RULES FOR JOINS:

1. There are exactly TWO actions, and every request ends in one of them — you either
   build the join, or you ask. You are a builder, not a chat partner: you do not
   answer questions as an end in itself, and you never report a request as
   impossible in a way that looks like a finished node. An informational question
   ("What columns are in source 1?", "What join types are supported?") is
   "ask_questions": answer it inside followUpQuestion, then ask what you still need.
   So is anything you cannot do — a named table that is not among the sources
   above, a request that contradicts them, or a write behaviour a join does not
   have (below).

   A join has THREE write modes ("operationMode"):
   - "new_table" (the default): every run REPLACES the target table with this
     run's joined rows.
   - "append": the target KEEPS its rows and this run's rows are added. The
     table is created on the first run if it does not exist yet.
   - "merge": like append, but rows whose key already exists in the target are
     UPDATED and the rest inserted (an upsert). Needs "mergeKeys" — the output
     column(s) that identify a row; if the user has not said which, ask. Only
     offered where the destination is marked "merge: yes" in Available
     Destinations; for any other destination say plainly it cannot merge and
     offer append, append with an anti-join, or replace.
   Pick the mode from the user's words: "append", "add to the existing table",
   "don't overwrite", "keep history" → append; "update existing rows",
   "upsert", "merge", "sync", "insert new and update changed" → merge;
   anything else → new_table. On a refinement that does not mention the mode,
   keep the current one (above). On a vector destination new_table replaces
   the stored records each run and append upserts them by id (merge = append).
   If the target table is ALSO one of the sources, "new_table" is refused at
   build time (replacing it would empty the source before it is read): say so
   in followUpQuestion and offer append / merge or a different target table.

2. When to ask_questions:
   - You are missing ANY of the following information needed to generate a join
   - Continue asking questions until you have ALL required information

   Required Information Checklist:
   a) Join Relationships: How each table connects to others (which columns match between tables)
      - NEVER assume relationships without asking
      - Ask: "Which column in [TableA] matches with which column in [TableB]?"
      - Get confirmation for EVERY table pair being joined

   b) Join Types: The type of join for each relationship
      - Ask: "Should this be an INNER join (only matching rows), LEFT join (all from TableA + matches from TableB), RIGHT join, or FULL OUTER join?"
      - For multiple sources: "How should [TableA] join to [TableB]? And how should the result join to [TableC]?"

   c) Column Selection: Which columns to include in the final output
      - Ask: "Which columns do you want in the final table? Please specify from each source."
      - Example: "From customers: customer_id, name; From orders: order_id, total"
      - \`["*"]\` means all of that source's columns (expanded from the list above).
        Use it alone, never mixed with names, when the user wants everything from
        a source. Otherwise name only columns the source actually has.

   d) Table Names and Context: Understanding what each source represents
      - If table names are unclear, ask: "Can you describe what data each source contains?"
   e) Target Table Name: REQUIRED
      - If user hasn't specified a name for the new table/collection, ask: "What would you like to name the new table/collection?"
      - This is MANDATORY before generating the join

3. When to generate_join:
   - ONLY when you have explicitly confirmed ALL of:
     a) Join relationships (exact column mappings between ALL tables)
     b) Join types (INNER/LEFT/FULL for each join)
     c) Column selection (which columns from each source)
     d) Target table name (REQUIRED)
   - User has explicitly stated this information in current or previous messages
   - NO ASSUMPTIONS about relationships even if column names look similar

4. Follow-up Question Guidelines:
   - Ask ONE clear, specific question at a time
   - Build on previous answers from chat history
   - Be specific: mention table names and column names you've seen
   - Write for someone who has never seen this system's internals. Ask about
     THEIR data — tables, columns, the result they want. Never mention the
     response format, "settings", "configuration", or what this JSON can or
     cannot express: the user cannot see those, cannot change them, and cannot
     answer a question about them. What happens to their TABLE on each run
     (rebuilt every time, never appended to) is about their data, not the
     format — say it plainly when their request depends on it.
   - Never ask a question whose only sensible answer is "yes". If there is one
     reasonable reading of the request, that is not a question — build it.
   - A request needing several joins, a filter between them, a de-duplication
     pass, or three or more sources chained in sequence is ORDINARY. The next
     step writes the join as free-form SQL, or as a JavaScript function for a
     NoSQL destination, so it can express any number of stages. How involved
     the join is, is never by itself a reason to ask.
   - Examples of good questions:
     * "I see TableA has 'customer_id' and TableB has 'cust_id'. Should these be joined together? If not, how should TableA be joined with TableB?"
     * "For the join between Customers and Orders, do you want an INNER join (only customers with orders) or LEFT join (all customers, even without orders)?"
     * "Which columns would you like in the final result? For example, from Customers: [list columns], from Orders: [list columns]"

5. NoSQL Destination Joins:
   - If destination is MongoDB, the join is performed with JavaScript in the local environment
   - Data from all sources will be loaded locally, joined using JavaScript, then uploaded to the destination
   - This allows for complex join logic that MongoDB doesn't natively support

5b. Vector / embedding scenarios (only when there is a vector source/destination or the user mentions embeddings, similarity, vectorising):
   - First, decide which scenario applies (see "Vector / embedding context detected" above): A) treat the vector DB as a regular DB, or B) do embedding/similarity search inside the join.
   - For Scenario A: ask only what's needed for a normal join (which metadata columns to match, join type, columns to keep). The vector source will be fetched with a metadata filter and treated like any NoSQL source.
   - For Scenario B: confirm with the user what should be embedded and against what (e.g. "for each customer, search the article index using customer.bio for the top 5 matches") and pick an embedding provider/model if there is choice. Any destination works — the join runs as a \`javascriptFunction\`.
   - Do not invent the embedding/search logic in static SQL. The actual embedding & similarity-search code is generated as part of the \`javascriptFunction\` in the join-generation step.

5c. SQL or a JavaScript function — the "requiresFunction" flag. It depends on the
    DESTINATION you pick, so decide it after the destination:
   - ALWAYS true, with nothing to decide:
       • a MongoDB destination, and a vector destination (a saved vector
         connection or local-lancedb) — these always join in JavaScript;
       • any join with vectorRequired: true.
   - For a SQL database or local-duckdb destination the default is false (SQL),
     and it stays false whenever SQL on that destination can do the job. Set it
     true ONLY when it cannot:
       • a join key, or a value to keep, sits INSIDE an array or a nested
         document / JSON value — a Mongo sub-document, a JSON or JSONB column, a
         nested field in a JSON file — and the destination is a SQL database,
         where the join would have to unpack it;
       • the match is not an equality or comparison SQL can express — fuzzy
         matching, a per-row API or AI call, a rule the user describes
         procedurally.
     It is about the DATA and the DESTINATION, never the source's engine: a
     Postgres JSONB column needs it as much as a Mongo array does, and a flat
     Mongo collection needs nothing.
   - local-duckdb reads nested values natively (dot notation for nested fields,
     unnest() for arrays), so nested data alone does NOT make it true there.
   - Nested or array data, whichever way this flag goes: before generate_join
     the user must have said how it should come out — e.g. "one row per item in
     the order, or one row per order with the items kept as JSON text?" —
     unless they already did. Never pick a shape for them: flattening,
     exploding and dropping nested values all change what the result means.

6. Confidence Requirement:
   - If you have ANY doubt about relationships, join types, or column selection → ask_questions
   - Only use generate_join when 100% certain from explicit user statements

Examples:

Example 1 - Need to ask questions:
User: "Join these tables together"
→ action: "ask_questions", followUpQuestion: "I see you have [SourceA] with columns [cols] and [SourceB] with columns [cols]. Which column in SourceA should match with which column in SourceB?"

Example 2 - Still asking follow-ups:
Previous conversation established join columns
Current: "Use customer_id to join"
→ action: "ask_questions", followUpQuestion: "Should this be an INNER join (only matching customers) or a LEFT join (all customers from the first table)?"

Example 3 - Ready to generate:
Previous conversation established join columns, join types
Current: "Include all columns from both tables"
→ action: "generate_join" with all inferredSettings populated

Example 4 - Informational:
User: "What columns are available in the first source?"
→ action: "ask_questions", followUpQuestion: "The first source contains these columns: ... Which of them should the join match on?"

Example 5 - Switching the write mode:
User: "Change the join to append mode."
→ action: "generate_join" with inferredSettings.operationMode "append" and everything else unchanged.

Example 6 - Merge, key known (destination marked "merge: yes"):
User: "Update the existing rows by customer_id and add the new ones."
→ action: "generate_join" with inferredSettings.operationMode "merge" and mergeKeys ["customer_id"].

Example 7 - Merge, destination cannot merge (marked "merge: no"):
User: "Upsert into the collection by customer_id."
→ action: "ask_questions", followUpQuestion: "This destination can't merge (update matching rows). I can append this run's rows, append only the rows that aren't there yet (an anti-join on customer_id), or replace the collection each run. Which one?"

CRITICAL OUTPUT FORMAT — respond with a SINGLE raw JSON object and NOTHING else. Do not wrap it in markdown code fences, and do not write any text, notes, or commentary before or after the object. If you need to explain something, answer a question, or say why you cannot proceed, put that text inside the "followUpQuestion" field and set "action" to "ask_questions" — never write prose outside the JSON. Any character outside the JSON object will break parsing and cause the request to fail.

The structure above is ANNOTATED, not literal: the "|" unions list the allowed values (pick ONE) and the "//" notes describe each field. Neither is part of the output. Your reply must be strict JSON — no comments, no "|", a comma between every pair of fields.

Watch the nesting: "inferredSettings" contains ONLY destinationSelection, operationMode, mergeKeys (merge only), targetTableName and selectedColumns. "reasoning" and "followUpQuestion" are SIBLINGS of "inferredSettings" at the top level, never inside it. Before you send, check that the last character is the "}" that closes the outermost object, not the one that closes "inferredSettings".
  `,

  /**
   * Generate join query for specific database type
   */
  generateJoinQuery: (dbType, sources, joinSettings, destinationConfig) => {
    // WHICH output contract this destination gets, decided ONCE, and every
    // rule below that depends on the destination reads these rather than
    // re-testing dbType.
    //
    // A local (DuckDB) destination and a SQL database share ONE contract:
    // CREATE TABLE {{TARGET}} plus INSERT INTO {{TARGET}} SELECT … . Local used
    // to be "write ONE SELECT, no CREATE, no INSERT", which the model kept
    // mixing up with the SQL one — an INSERT nested inside the executor's
    // CREATE OR REPLACE TABLE … AS, dead on arrival. One contract leaves
    // nothing to mix up.
    const isVectorDest = !!destinationConfig.isVectorDestination;
    const isDocumentDest = !isVectorDest && dbType === 'mongodb';
    const isLocalFileDest = !isVectorDest && !isDocumentDest && dbType === 'duckdb';
    // A real SQL database. With a local destination these are the two whose
    // joinSql writes (INSERT INTO {{TARGET}}); a document or vector destination
    // takes a function and names no target in SQL.
    const isSqlDest = !isVectorDest && !isDocumentDest && !isLocalFileDest;
    // A function join into a TABLE destination (local, or a SQL database): one
    // SQL on that destination cannot express — embeddings, nested or array
    // values into a SQL table, a match SQL has no form for. The builder resolves
    // `requiresFunction` (the analyser's verdict, forced true for embedding
    // joins); the executor writes the rows the function returns as the target
    // table. It replaces the SELECT (local) and INSERT … SELECT (SQL) contracts.
    const isFunctionTableDest = !!(destinationConfig.requiresFunction || destinationConfig.vectorRequired)
      && (isLocalFileDest || isSqlDest);

    return `
You are an expert in ${dbType} database systems. Generate a complete join query.

Sources to Join:
${JSON.stringify(sources, null, 2)}

Join Settings:
${JSON.stringify(joinSettings, null, 2)}

Destination Configuration:
${JSON.stringify(destinationConfig, null, 2)}
${((isSqlDest || isLocalFileDest) && !isFunctionTableDest) ? `
- Write the destination table as {{TARGET}} — the table name in "targetDdl"
  (CREATE TABLE {{TARGET}} (...)) and the write target in "joinSql"
  (INSERT INTO {{TARGET}} ..., or MERGE INTO {{TARGET}} ... in merge mode). The real name, quoted for this engine, is
  filled in after you answer; never write it yourself.
- Write mode is "${joinSettings.operationMode || 'new_table'}". ${joinSettings.operationMode === 'merge' ? `"joinSql" is a MERGE / upsert into {{TARGET}} on the key column(s)
  ${(destinationConfig.mergeKeys || []).join(', ') || '(see the conversation)'} — update the rows that match, insert the rest. On this
  destination: ${destinationConfig.mergeGuidance || 'use its MERGE statement'}
  The joined rows are the merge's SOURCE (USING (<the SELECT over the {{SOURCE_n}} tables>)).
  "targetDdl" is still the CREATE TABLE for the first run (declare the key as PRIMARY
  KEY where the upsert form above needs it). The executor never drops the target in
  this mode.` : `You write the same two statements either way —
  the executor runs the CREATE only when the target must be (re)made and never
  drops it in append mode.`}
` : ''}${destinationConfig.existingTarget ? `
EXISTING TARGET TABLE — {{TARGET}} already exists on the destination, and in
write mode "${joinSettings.operationMode}" this join KEEPS it, so your statements
run against it exactly as it is now:
${destinationConfig.existingTarget}
- If your INSERT / MERGE (or, for a function join, its rows) can go into that
  table unchanged, write them for it and return
  "targetSchemaChange": {"required": false}.
- If they cannot — a column your output has is missing, a column type cannot
  hold your values, its PRIMARY KEY would reject rows this join writes (for
  example a key left by an earlier merge while appending repeats that key), or a
  merge needs a key the table does not have — return
  "targetSchemaChange": {"required": true, "reason": "<one sentence a user can read>"}
  and write "targetDdl" for the table you need. The table is then dropped and
  recreated ONCE, after the user approves; later runs keep it again.
- Always return "targetPrimaryKey": the key columns your targetDdl declares, or [].
` : ''}${(isSqlDest && isFunctionTableDest && destinationConfig.quotedTargetRef) ? `
- Write the destination table in SQL as EXACTLY: ${destinationConfig.quotedTargetRef}
  Use that form as the table name in "targetDdl" and the FROM clause in
  "previewSql". Do not re-quote, re-case, add a schema or strip one.
` : ''}
Source Requirements:
Each source has been analyzed to determine what fields are needed based on source type and destination type.

${sources.map((src, idx) => `
Source ${idx + 1}: ${src.sourceNodeLabel || src.sourceNodeId}
- sourceNodeId: ${src.sourceNodeId}
- Table/Index: ${src.tableName}${src.quotedTableRef ? `
- Write it in SQL as EXACTLY: ${src.quotedTableRef}` : ''}${src.quotedColumns ? `
- Write its columns in SQL as EXACTLY: ${Object.values(src.quotedColumns).join(', ')}` : ''}
- Source Type: ${src.dbType || 'unknown'}${src.isSourceVector ? ' [VECTOR DB]' : ''}${src.localPath ? `
- Absolute path (this is the \`localPath\`, and the \`dbPath\` to pass ctx.runQuery): ${src.localPath}` : ''}${(isLocalFileDest || isFunctionTableDest || isVectorDest || isDocumentDest) ? '' : `
- In Destination DB: ${src.isInDestinationDb ? 'Yes (no temp table needed)' : 'No (needs temp table)'}`}
- Required Fields: ${src.requiredFields.length > 0 ? src.requiredFields.join(', ') : 'None'}${src.placeholder && src.localView ? `
- In the join it is readable as ${src.placeholder} — write it only that way in "joinSql".${src.requiredFields.length ? ' Give it the fields above (its own read) and nothing else.' : ' Its "sourcesConfig" entry is just its sourceNodeId.'}` : src.placeholder ? (src.staged ? `
- On the destination it is loaded into a temp table. Write that table as ${src.placeholder}
  — in this source's "ddl" (CREATE TABLE ${src.placeholder} (...)) and in "joinSql".` : `
- Already in the destination: nothing is staged. Write it as ${src.placeholder} in "joinSql".
  Its "sourcesConfig" entry is just {"sourceNodeId": "${src.sourceNodeId}"}.`) : ''}
`).join('')}

Identifier quoting: where a source above gives a "Write it in SQL as EXACTLY"
form, copy that string verbatim — the table form into the FROM clause of that
source's \`sql\`, and the column forms wherever you name that source's columns
in it. They are already quoted for that engine: do not re-quote them, re-case
them, add a schema, or strip one. The engines disagree about names written
bare: Snowflake folds them to UPPER case, MySQL and PostgreSQL to lower, so a
table or column whose real name is lower-case, mixed-case, or contains a dot is
reachable only when quoted. Writing a name yourself is how a join reads an
object that does not exist while the same one answers perfectly to the form
given above.

An ALIAS you invent is your own new name, not one of these — write it plain:
\`SELECT "unit_price" AS tp_unit_price\`. And a source with no quoted forms
listed keeps the plain names shown above.

${sources.some((s) => s.placeholder) ? `Source placeholders: on the destination, write each source ONLY as its
{{SOURCE_n}} placeholder given above — never a table name of your own, quoted
or not. The real, quoted name is filled in after you answer. Every source must
appear in "joinSql". A source's own "sql" reads its own database, so it never
contains a placeholder.

` : ''}

Source ids: every "sourceNodeId" you write — in "sourcesConfig" and as a key of
"selectedColumns" — must be one of these, copied character for character:
${sources.map((src) => `  ${src.sourceNodeId}`).join('\n')}
These are opaque keys the executor uses to look up each source's connection.
Never invent one, never add or drop a suffix, never substitute a label or a
table name: an id that is not on this list has no connection behind it and the
join fails at run time.

Column selection: in the TOP-LEVEL "selectedColumns" map, \`["*"]\` means all of
that source's columns as listed above — use it when you carry a whole side
through (a \`t1.*\` in joinSql must be \`["*"]\` here), alone, never mixed with
column names. Otherwise list only columns the source actually has, or your own
SQL aliases. The per-source "selectedColumns" array in "sourcesConfig" is a
different field: explicit names only, "*" is never valid there.

${sources.some((s) => s.isSourceVector) ? `
## Vector source(s) detected — Scenario A (treat as a regular DB)
For each vector source emit \`vectorFetchOperation\` instead of \`sql\`/\`nosqlOperation\`. The executor pulls the rows, flattens id + metadata into top-level columns (the vector itself is dropped), and from then on the rows are treated exactly like a NoSQL source — ${(isFunctionTableDest || isVectorDest || isDocumentDest)
    ? 'they arrive as one of the arrays your `javascriptFunction` is called with.'
    : (isLocalFileDest
      ? 'they are staged and readable under the source\'s {{SOURCE_n}} placeholder in your `joinSql`.'
      : 'they are loaded into the source\'s temp table, which your `joinSql` reads.')}

\`vectorFetchOperation\` shape:
{
  "useEmbeddingSearch": false,
  "filter": "<LanceDB SQL WHERE>" | { /* Pinecone metadata filter */ } | "" | {},
  "topK": 10000
}
Do NOT emit \`searchQuery\` here. If the user wants similarity search instead, switch to Scenario B (a JS-function join with embedding / search done at runtime via \`ctx\`).
` : ''}
${destinationConfig.vectorRequired ? `
## Scenario B — embedding / similarity search inside the join (\`javascriptFunction\` + \`ctx\`)
When the user wants embeddings or similarity search to be part of the join logic (e.g. "for each customer, find the 5 most similar articles", "vectorize this column and upsert", "fuzzy match on text"), express the entire embedding/search/match flow inside the AI-written async \`javascriptFunction\`. Emit NO \`joinSql\`: no SQL engine here can call an embedding model, and a join with no \`joinSql\` is exactly what tells the executor to run your function. Any destination works — see step 3.

### How this actually runs (read this before generating anything)
The destination DB does NO compute here — it is only the place the final rows get written. Embedding, similarity search, joining, and any extra lookups all run **locally in Node**, inside the \`javascriptFunction\` you emit. Concretely the executor performs these steps in order:

  1. Load each source's rows into memory:
       • SQL source     → executor runs the \`sql\` you emit on that source
       • NoSQL source   → executor runs the \`nosqlOperation\` you emit
       • Vector source  → executor pulls rows via \`vectorFetchOperation\` (filter-only fetch — \`useEmbeddingSearch: false\` is fine; if you need similarity search at runtime, do it from inside the function instead, via \`ctx.runQuery(...)\`)
       • Local file source → executor runs the \`sql\` you emit against it (the file is readable under its table name)
  2. Call your function: \`const joinedRows = await joinData(source1Data, source2Data, /* …, */ ctx);\` — ONE parameter per source that has a read (sql / nosqlOperation / vectorFetchOperation), in source order, then ctx LAST. A vector source you search through ctx has no read and NO parameter.
     Inside the function you may freely call \`await ctx.vectorize(...)\` to embed text and \`await ctx.runQuery(connection, query, dbPath?)\` to do per-row similarity searches, ad-hoc lookups, etc. None of this requires the destination to support SQL or vectors.
  3. Insert the array you return into the destination:
       • NoSQL destination → bulk insert into the target collection
       • Vector destination → embed the chosen column and upsert vectors (you also emit a \`vectorDestination\` block — see below)
       • Local destination → the rows become this node's table in the workflow's DuckDB database
       • SQL destination → the target is created from your \`targetDdl\`, then the rows are inserted by column name

So if the user picks MongoDB, a local table or a SQL database as the destination, that's fine. It doesn't need to "execute SQL" or "generate embeddings" — your function does, in Node, before the rows are inserted. Do NOT ask the user to switch to Postgres+pgvector / Snowflake / etc. for this reason; pick whichever destination they chose and put the embedding + search logic inside the function.

Function contract:

  async function joinData(source1Data, source2Data, /* …, */ ctx) {
    // ... your logic ...
    return joinedRows; // array of objects
  }

The \`ctx\` argument is appended after all source-data arrays. It exposes simple async helpers (same surface as the javascript-executor skill):

- ctx.connections                 -> [{ id, name, dbType, dbCategory }]
- ctx.aiProviders                 -> available providers, e.g. ['openai']
- ctx.embeddingProviders          -> available embedding providers
- await ctx.runQuery(connection, queryStringOrObject, dbPath?)
    Saved connection (dbPath omitted):
      SQL:    ctx.runQuery('warehouse', 'SELECT id, email FROM users')
      NoSQL:  ctx.runQuery('mongo-prod', { collection: 'users', filter: {}, limit: 100 })
    Local file (duckdb / lancedb) — pass the dbType in place of the connection
    name, plus the absolute path as dbPath. A node writing locally shows
    targetConnectionId "local-duckdb" / targetConnectionName "Local file"; use
    its targetLocalPath here:
      duckdb:  ctx.runQuery('duckdb', 'SELECT COUNT(*) AS c FROM orders', '/abs/path/orders.csv')
               (the file is queried where it sits — csv, json or parquet — and
                is addressable by its own base name, here "orders")
      lancedb: ctx.runQuery('lancedb', { operation: 'list', tableName: 'docs', limit: 100 }, '/abs/path/lancedir')
- await ctx.getTables(connection, dbPath?)
- await ctx.getColumns(connection, table, schema?, dbPath?)
- await ctx.askAi(prompt, { provider?, model?, systemPrompt?, maxTokens? })
- await ctx.vectorize(['text', ...], { provider?, model? })   -> array of vectors aligned with the input texts
- ctx.axios                                                   -> axios module for arbitrary HTTP
- ctx.log(...args)

Vector operations for ctx.runQuery — the result shapes differ by store, so read
the score from the field THAT store returns (LanceDB: \`_distance\`, lower =
closer; Pinecone: \`score\`, higher = closer). Never assume a field the guide
does not list:
${VECTOR_QUERY_GUIDE}

Ask a search for only the neighbours you need: top-K plus the matches you will
drop (e.g. topK: N + 1 when excluding the row itself), not the whole table.

\`connection\` accepts either the saved connection's name/id, OR — when reading
a local file — the dbType string ('duckdb' | 'lancedb'). Source data
arrays passed as the leading arguments are already loaded — use them as-is
unless you genuinely need fresh data.${destinationConfig.hasLocalConnection ? `

Local files are part of this join (one or more sources / the destination is a
local file). For those, you MUST pass the absolute \`dbPath\` as the trailing
argument and use the dbType string in place of the connection name.
${sources.some((s) => s && s.localPath)
  ? `Every local source's path is printed under it in "Source Requirements"
above as "Absolute path" (and in the JSON at the top of this prompt as
\`localPath\`) — copy that string verbatim. Never rewrite, shorten or guess at a
path: those are the only local paths this join has.`
  : `NO source in this join has a local path, so there is none to copy: take
every source from the row arrays you are handed. Never invent a path or a
filename — a made-up one either reads the wrong file or fails after every source
has already been loaded.`}

Examples:

  ctx.runQuery('duckdb', 'SELECT * FROM customers LIMIT 1000', '/abs/path/customers.csv')
  ctx.runQuery('duckdb', { query: 'SELECT count(*) AS n FROM orders' }, '/abs/path/orders.parquet')
  ctx.runQuery('lancedb', { operation: 'queryVectors', tableName: 'docs', queryVector: v, topK: 5 }, '/abs/path/lancedir')
  ctx.runQuery('lancedb', { operation: 'upsert',  tableName: 'docs', data: records },          '/abs/path/lancedir')` : ''}

Pattern for similarity search joins (per-row, semantic match):

  async function joinData(customers, ctx) {
    // 1. Embed the driving column once per unique value.
    const queries = [...new Set(customers.map(c => c.bio).filter(Boolean))];
    const queryVectors = await ctx.vectorize(queries, { provider: 'openai', model: 'text-embedding-3-small' });
    const byQuery = new Map(queries.map((q, i) => [q, queryVectors[i]]));

    // 2. For each customer, search the vector connection for top-K neighbours.
    const results = [];
    for (const c of customers) {
      const v = byQuery.get(c.bio);
      if (!v) continue;
      const matches = await ctx.runQuery('article-index', {
        operation: 'queryVectors',
        queryVector: v,
        topK: 5,
        filter: {}
      });
      for (const m of matches) {
        // Pinecone returns \`score\` (higher = closer); a LanceDB search
        // returns \`_distance\` (lower = closer) — use the one your store returns.
        results.push({ ...c, ...m, _score: m.score });
      }
    }
    return results;
  }

Notes:
- For Scenario B, do NOT emit \`vectorFetchOperation\` for the vector connection if you intend to run the search inside the function — instead reference it through \`ctx.runQuery(connectionName, { operation: 'queryVectors', ... })\` so each query happens at the right time with the right vector. That source is then NOT loaded and gets NO parameter: \`joinData(otherSourceRows, ctx)\`.
- For Scenario A (no embeddings), you SHOULD still emit \`vectorFetchOperation\` so the executor pre-loads the rows and you can use them like NoSQL data.
- The function must return an array of plain objects. Vector-destination joins also need a top-level \`vectorDestination\` block — see the "Vector destination" section.
` : ''}

${destinationConfig.isVectorDestination ? `
## Vector destination
The destination is a vector database. The executor will:
  1. Load every source into memory (using your \`sql\`/\`nosqlOperation\`/\`vectorFetchOperation\` per source).
  2. Run your \`javascriptFunction\` to produce an array of joined rows.
  3. Call the \`vector-db-executor\` skill to embed ONE column from the joined rows and upsert vectors into the destination.

You MUST emit a \`javascriptFunction\` (no SQL) plus these top-level vector destination fields:
  "vectorDestination": {
    "vectorDbType": "lancedb" | "pinecone" | "<other>",
    "targetTable": "<index/table name>",
    "columnToEmbed": "<column from the joined output>",
    "embeddingProvider": "openai",
    "embeddingModel": "<provider-specific model id>",
    "idColumn": "<joined-output column that is the row's primary key>",   // omit if there isn't one
    "indexName": "<lowercase-with-hyphens>",   // Pinecone only
    "namespace": "<optional>"                    // Pinecone only
  }
Vectors are UPSERTED under "idColumn": a re-run replaces the records it wrote
before. Use the joined row's real key (employee_id, order_id, sku) — normally
NOT the embedded column, since two rows can share the same text. Only name a
column of the joined output that plausibly identifies one row; if nothing
qualifies, OMIT it — ids then fall back to a hash of the whole row, so a row
whose fields change is written as a new record. Never use a column just because it is called
"id". Do not ask the user about it.
Do NOT emit \`targetDdl\`, \`joinSql\`, or \`previewSql\` — those are skipped for vector destinations.
` : ''}

"targetColumns" is every column the JOINED OUTPUT actually contains, in order —
the names as they land in the result, ALIASES INCLUDED. Downstream nodes are
configured from this list and nothing else, so it must describe what comes OUT,
not what went in:

  joinSql: SELECT s.customer_id, c.name AS customer_name, s.total_spend ...
  targetColumns: [{"name":"customer_id","type":"VARCHAR"},
                  {"name":"customer_name","type":"VARCHAR"},   <- the ALIAS
                  {"name":"total_spend","type":"DOUBLE"}]

Writing "name" there because that is what the source calls it produces SQL
further down the pipeline that selects a column the result does not have. This
is separate from "selectedColumns", which records which columns you READ from
each source; the two differ exactly wherever you alias, compute or rename.
For a JavaScript join, list the keys of the objects the function returns.

Output Structure:
${destinationConfig.isVectorDestination ? `
FOR VECTOR DESTINATION:
All sources are loaded into memory and joined with JavaScript. The skill embeds a chosen column on the joined output and upserts vectors.

{
  "explanation": "Description of join logic",
  "sourcesConfig": [
    {
      "sourceNodeId": "...",
      // Provide ONE of:
      "sql": "SELECT col1, col2 FROM table {LIMIT_OFFSET_HERE}",            // SQL source
      "nosqlOperation": "{ \\"collection\\": \\"users\\", \\"filter\\": {} }",  // NoSQL source
      "vectorFetchOperation": { "useEmbeddingSearch": false, "filter": "", "topK": 10000 } // Vector source
    }
  ],
  "javascriptFunction": "function joinData(source1Data, source2Data) { /* return joined rows */ }",
  "selectedColumns": {"sourceNodeId1": ["col1"], "sourceNodeId2": ["col2"]},
  "targetColumns": [{"name": "col", "type": "TYPE"}],   // every column the OUTPUT has, aliases included — see above
  "vectorDestination": {
    "vectorDbType": "lancedb",
    "targetTable": "${destinationConfig.tableName}",
    "columnToEmbed": "<column-from-joined-output>",
    "embeddingProvider": "openai",
    "embeddingModel": "text-embedding-3-small",
    "idColumn": "<joined-output primary-key column — omit if none>"
  }
}
` : (dbType === 'mongodb' ? `
FOR NOSQL DESTINATION:
All sources are loaded into memory and joined using JavaScript.

{
  "explanation": "Description of join logic",
  "sourcesConfig": [
    // For each source, include sourceNodeId and ONLY its required fields
    {
      "sourceNodeId": "...",
      "nosqlOperation": "...",   // EITHER, if the source is NoSQL: JSON string like {\\"collection\\": \\"users\\", \\"filter\\": {}}
      "sql": "..."               // OR, if the source is SQL: SELECT statement to fetch data. MUST end with {LIMIT_OFFSET_HERE}. Emit "sql" or "nosqlOperation" for a source, never both
    }
  ],
  "javascriptFunction": "function joinData(source1Data, source2Data, ...) { /* join logic */ return results; }",
  "targetCollection": "${destinationConfig.tableName}",
  "selectedColumns": {"sourceNodeId1": ["col1", "col2"], "sourceNodeId2": ["col3"]},
  "targetColumns": [{"name": "col", "type": "TYPE"}],   // every column the OUTPUT has, aliases included — see above
}

Example (NoSQL source + SQL source):
{
  "explanation": "Join MongoDB users with PostgreSQL orders on user_id",
  "sourcesConfig": [
    {
      "sourceNodeId": "node-abc-123",
      "nosqlOperation": "{\\"collection\\": \\"users\\", \\"filter\\": {}}"
    },
    {
      "sourceNodeId": "node-def-456",
      "sql": "SELECT order_id, user_id, total FROM orders {LIMIT_OFFSET_HERE}"
    }
  ],
  "javascriptFunction": "function joinData(usersData, ordersData) { const results = []; for (const user of usersData) { for (const order of ordersData) { if (user.user_id === order.user_id) { results.push({ user_id: user.user_id, name: user.name, order_id: order.order_id, total: order.total }); } } } return results; }",
  "targetCollection": "user_orders",
  "selectedColumns": {"node-abc-123": ["user_id", "name"], "node-def-456": ["order_id", "total"]}
}
` : (isFunctionTableDest ? `
FOR A JAVASCRIPT JOIN INTO ${isLocalFileDest ? 'A LOCAL' : 'A SQL'} DESTINATION:
SQL on this destination cannot express this join — it embeds or runs a
similarity search, matches on values inside arrays or nested documents, or uses
a rule SQL has no form for — so it is a JavaScript join even though the
destination is a table. The executor loads every source into memory
(each source's "sql" / "nosqlOperation" / "vectorFetchOperation"), calls

    await joinData(source1Rows, source2Rows, /* …one array per source WITH a
                   read, in the order listed above… */, ctx)

A vector source you search through ctx (no vectorFetchOperation) is not
loaded and has no parameter — ctx is always the last argument.

where nested values arrive as real objects and arrays, and ${isLocalFileDest
    ? `writes the rows it returns as this node's table in the workflow's DuckDB
database. Emit NO "targetDdl" and NO "joinSql".`
    : `writes the rows it returns into the destination table: it drops the target,
runs your "targetDdl", then inserts the rows in batches BY COLUMN NAME. Emit a
"targetDdl" and NO "joinSql".
- Every key of every object your function returns must be a column in
  "targetDdl" (a key with no column fails the insert), with types valid in the
  DESTINATION's dialect.
- Return flat rows: scalar values only — a SQL column cannot hold an array or
  an object.`}
- Shape nested or array values EXACTLY as the user asked in the conversation
  (one row per element, or the value kept as JSON text, …). Never choose a
  shape yourself: flattening, exploding or dropping a nested value changes
  what the result means.
- No temp tables: sources are never staged.

{
  "explanation": "Description of join logic",
  "sourcesConfig": [
    {
      "sourceNodeId": "...",
      // Provide ONE of:
      "sql": "SELECT col1, col2 FROM table {LIMIT_OFFSET_HERE}",            // SQL or local-file source
      "nosqlOperation": "{ \\"collection\\": \\"users\\", \\"filter\\": {} }",  // NoSQL source
      "vectorFetchOperation": { "useEmbeddingSearch": false, "filter": "", "topK": 10000 } // Vector source
    }
  ],
  "javascriptFunction": "async function joinData(source1Data, source2Data, ctx) { /* match; return rows */ }",${isLocalFileDest ? '' : `
  "targetDdl": "CREATE TABLE ${destinationConfig.quotedTargetRef || destinationConfig.tableName} (col1 TYPE, col2 TYPE)",   // SINGLE CREATE TABLE, destination dialect, no DROP
  "previewSql": "SELECT * FROM ${destinationConfig.quotedTargetRef || destinationConfig.tableName} LIMIT 100",`}
  "selectedColumns": {"sourceNodeId1": ["col1"], "sourceNodeId2": ["col2"]},
  "targetColumns": [{"name": "col", "type": "TYPE"}]   // exactly the keys your function's rows carry
}
` : (`
FOR A SQL OR LOCAL (DuckDB) DESTINATION:
Write two statements: "targetDdl" creates {{TARGET}}, and "joinSql" fills it with
INSERT INTO {{TARGET}} SELECT … . Name every source by its {{SOURCE_n}}
placeholder (see Source Requirements). On a database, a source from elsewhere is
loaded into a temp table first (its "ddl"); one already there is read where it
is. On a local destination every source is already readable — none has a "ddl".
${isLocalFileDest ? `
The dialect is DuckDB (PostgreSQL-flavoured). Useful extras: SELECT * EXCLUDE
(col), SELECT * REPLACE (expr AS col), QUALIFY, GROUP BY ALL. Nested values read
as STRUCT (dot notation, addr.city), LIST (1-based index, items[1], or unnest()
to expand to rows) or MAP (bracket by key, attrs['color']). A key/value object
is a STRUCT when its keys are few and stable and a MAP once there are 200+
distinct keys — the schema above says which, so read it rather than assume.
` : ''}
{
  "explanation": "Description of join logic",
  "sourcesConfig": [
    // For each source, include sourceNodeId and ONLY its required fields
    {
      "sourceNodeId": "...",
      "ddl": "CREATE TABLE {{SOURCE_1}} (col1 TYPE, col2 TYPE, col3 TYPE)",   // Only for a staged source. Columns in the SAME ORDER as selectedColumns
      "sql": "SELECT col1, col2, col3 FROM ... {LIMIT_OFFSET_HERE}",   // EITHER, for a SQL source: must end with {LIMIT_OFFSET_HERE}. Columns in SELECT MUST be in the SAME ORDER as selectedColumns
      "nosqlOperation": "...",   // OR, for a NoSQL source needing a temp table: JSON string query. Emit "sql" or "nosqlOperation", never both
      "selectedColumns": ["col1", "col2", "col3"]   // Array defining column order - DDL, SQL, and this array MUST all match
    }
  ],
  "targetDdl": "CREATE TABLE {{TARGET}} (col1 TYPE, col2 TYPE)",   // ALWAYS required — a SINGLE CREATE TABLE and nothing else. The executor drops the target itself when it replaces it, so never add a DROP or a second statement
  "joinSql": "INSERT INTO {{TARGET}} SELECT ... FROM {{SOURCE_1}} t1 JOIN {{SOURCE_2}} t2 ...",
  "previewSql": "SELECT * FROM {{TARGET}} LIMIT 100",
  "joinColumns": [{"table1": "col", "table2": "col"}],
  "selectedColumns": {"sourceNodeId1": ["col1"], "sourceNodeId2": ["col2"]},
  "targetColumns": [{"name": "col", "type": "TYPE"}],   // every column the OUTPUT has, aliases included — see above
}

CRITICAL REQUIREMENTS for DDL, SQL, and selectedColumns order:
1. selectedColumns MUST be an array of column names: ["col1", "col2", "col3"]
2. DDL column order MUST match selectedColumns order exactly: CREATE TABLE (col1 TYPE, col2 TYPE, col3 TYPE)
3. SQL SELECT column order MUST match selectedColumns order exactly: SELECT col1, col2, col3 FROM ...
4. All three (DDL columns, SQL SELECT columns, selectedColumns array) MUST be in the SAME ORDER
5. For NoSQL sources, selectedColumns defines the order fields will be extracted from documents
6. This ensures INSERT statements generated from selectedColumns will match the temp table structure
7. CRITICAL: ALL SQL SELECT statements in the "sql" field MUST end with the placeholder {LIMIT_OFFSET_HERE}
   - This placeholder will be replaced with database-specific pagination syntax (LIMIT/OFFSET, TOP, FETCH, etc.)
   - Example: "SELECT col1, col2 FROM table {LIMIT_OFFSET_HERE}"
   - Do NOT add your own LIMIT/OFFSET clauses - only use the placeholder
8. CRITICAL: "targetDdl" and every per-source "ddl" are a SINGLE CREATE TABLE and
   nothing else — no DROP, no second statement (only the first statement runs). The
   executor decides when to drop and create the target.
9. CRITICAL: every "ddl" and "targetDdl" runs on the DESTINATION, so its column types
   MUST be valid in the DESTINATION's dialect — never in a source's.
   - Do NOT copy the type names out of a source's sourceTableSchema. Those describe
     where the data is READ FROM. A source's "VARCHAR" / "DOUBLE" / "TEXT" comes from
     DuckDB, Snowflake or Postgres and may not even parse on the destination.
   - Translate each column to the destination's own type, sized where that dialect
     requires it. MySQL and SQL Server REJECT a bare VARCHAR — it must carry a length,
     e.g. VARCHAR(255). Postgres, DuckDB and Snowflake accept a bare VARCHAR.
   - When a source type has no exact destination equivalent, choose the nearest one
     that holds the values; a wider string type is safer than a numeric guess.
   - Getting this wrong fails the CREATE TABLE, and the join then reports the missing
     table rather than the type that was refused.
10. CRITICAL: write tables ONLY as placeholders — {{TARGET}} for the destination,
   {{SOURCE_n}} for each source on the destination side. Never a table name of
   your own for either.

Example 1 (External SQL source + SQL source in destination):
{
  "explanation": "Join external customers with orders already in destination",
  "sourcesConfig": [
    {
      "sourceNodeId": "node-abc-123",
      "ddl": "CREATE TABLE {{SOURCE_1}} (customer_id INT, name VARCHAR(255));", // Note: DDL order matches selectedColumns
      "sql": "SELECT customer_id, name FROM customers {LIMIT_OFFSET_HERE}", // Note: reads the SOURCE's own table; SELECT order matches selectedColumns, ends with placeholder
      "selectedColumns": ["customer_id", "name"] // Note: All three (DDL, SQL, selectedColumns) have same order
    },
    {
      "sourceNodeId": "node-def-456"
      // No fields - orders table already exists in destination ({{SOURCE_2}})
    }
  ],
  "targetDdl": "CREATE TABLE {{TARGET}} (customer_id INT, name VARCHAR(255), order_id INT);",
  "joinSql": "INSERT INTO {{TARGET}} SELECT t1.customer_id, t1.name, t2.order_id FROM {{SOURCE_1}} t1 INNER JOIN {{SOURCE_2}} t2 ON t1.customer_id = t2.customer_id;",
  "previewSql": "SELECT * FROM {{TARGET}} LIMIT 100;",
  "joinColumns": [{"{{SOURCE_1}}": "customer_id", "{{SOURCE_2}}": "customer_id"}],
  "selectedColumns": {"node-abc-123": ["customer_id", "name"], "node-def-456": ["order_id"]}
}

Example 2 (NoSQL source needing temp table for SQL destination):
{
  "explanation": "Load MongoDB users into temp table, join with SQL orders",
  "sourcesConfig": [
    {
      "sourceNodeId": "node-abc-123",
      "ddl": "CREATE TABLE {{SOURCE_1}} (user_id INT, name VARCHAR(255));", // Note: DDL order matches selectedColumns
      "nosqlOperation": "{\\"collection\\": \\"users\\", \\"filter\\": {}}", // Note: Will extract user_id, name in that order
      "selectedColumns": ["user_id", "name"] // Note: Defines extraction and insertion order
    },
    {
      "sourceNodeId": "node-def-456",
      "ddl": "CREATE TABLE {{SOURCE_2}} (order_id INT, user_id INT);", // Note: DDL order matches selectedColumns
      "sql": "SELECT order_id, user_id FROM orders {LIMIT_OFFSET_HERE}", // Note: SELECT order matches selectedColumns, ends with placeholder
      "selectedColumns": ["order_id", "user_id"] // Note: All three (DDL, SQL, selectedColumns) have same order
    }
  ],
  "targetDdl": "CREATE TABLE {{TARGET}} (user_id INT, name VARCHAR(255), order_id INT);",
  "joinSql": "INSERT INTO {{TARGET}} SELECT t1.user_id, t1.name, t2.order_id FROM {{SOURCE_1}} t1 INNER JOIN {{SOURCE_2}} t2 ON t1.user_id = t2.user_id;",
  "previewSql": "SELECT * FROM {{TARGET}} LIMIT 100;",
  "joinColumns": [{"{{SOURCE_1}}": "user_id", "{{SOURCE_2}}": "user_id"}],
  "selectedColumns": {"node-abc-123": ["user_id", "name"], "node-def-456": ["order_id"]}
}

Example 3 (LOCAL destination: a local file + a remote database):
{
  "explanation": "Attach region names from Postgres to the local orders file",
  "sourcesConfig": [
    { "sourceNodeId": "node-abc-123" },
    {
      "sourceNodeId": "node-def-456",
      "sql": "SELECT city, region FROM dim_region {LIMIT_OFFSET_HERE}",
      "selectedColumns": ["city", "region"]
    }
  ],
  "targetDdl": "CREATE TABLE {{TARGET}} (region VARCHAR, orders BIGINT, revenue DOUBLE)",
  "joinSql": "INSERT INTO {{TARGET}} SELECT r.region, count(*), round(sum(o.amount), 2) FROM {{SOURCE_1}} o LEFT JOIN {{SOURCE_2}} r ON o.city = r.city GROUP BY r.region",
  "previewSql": "SELECT * FROM {{TARGET}} LIMIT 100",
  "joinColumns": [{"{{SOURCE_1}}": "city", "{{SOURCE_2}}": "city"}],
  "selectedColumns": {"node-abc-123": ["city", "amount"], "node-def-456": ["region"]}
}
`)))}

User Request Context: "${joinSettings.userRequest}"

Based on the user's request and conversation history, determine:
1. How each source should be queried (SELECT statements for SQL, nosqlOperation for NoSQL)
2. Join relationships between table pairs (which columns match, and what join type for each pair)
3. Which columns to include in the final result (default to all if not specified)
4. The final join logic that combines all sources appropriately

Note: Each table pair can have different join types (e.g., Table A INNER JOIN Table B, result LEFT JOIN Table C).

CRITICAL OUTPUT FORMAT — respond with a SINGLE raw JSON object and NOTHING else. Do not wrap it in markdown code fences, and do not write any text, notes, or commentary before or after the object. Only return the keys provided in this prompt, and put any explanation inside the JSON's "explanation" field. Any character outside the JSON object will break parsing and cause the request to fail.

The output structures above are ANNOTATED, not literal: the "//" notes describe each field and are NOT part of the output. Your reply must be strict JSON — no comments, a comma between every pair of fields, and every "{" and "[" closed. Before you send, check that the LAST character is the "}" that closes the outermost object.
  `;
  },

};

const ChatPrompts = {
  join: JoinPrompts
};

module.exports = ChatPrompts;
module.exports.default = ChatPrompts;
