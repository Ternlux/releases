// The table an in-place statement addresses. A caller may pass the name
// directly, or `{ nodeId }` for a file source — that case is staged under a
// per-node table by public/transfomers/DuckDB.js, and this is the one place
// the name is worked out so the prompt and the executor cannot disagree.
const DuckDB = require('../transfomers/DuckDB');

function resolveInPlaceTable(target, sourceTableSchema) {
  if (target && typeof target === 'object') {
    return DuckDB.stagingTableFor(target.nodeId, target.fallback || sourceTableSchema?.tableName);
  }
  return target || sourceTableSchema?.tableName;
}

const prompts = {

transfomer: {
        // Local transformation prompts. Remote database prompts are generated
        // from plugins via window.electronAPI.dbConnect.generateTransformPrompt

        // Local transformations run on DuckDB. The source is read where it sits
        // (a file, or an upstream node's table) and the result becomes this
        // node's own table in the workflow's database. New-table mode is a
        // SELECT that defines the result; in-place mode is the ALTER / UPDATE /
        // DELETE the user actually asked for, run against the existing table.
        duckdbTransformationNewTable: (settings, sourceTableInfo, settingsContext, sourceTableSchema, targetTableName) => `You are a DuckDB expert transforming a local data file.

        User's transformation request: "${settings.userRequest}"

        ${sourceTableInfo}

        Those sample rows are the output of a DuckDB query, not the raw file or
        document. They show how a value ENCODES on the way into JSON, which is
        not always how it is typed — the Columns list above is what your SQL
        binds against, so trust it over the sample when they disagree:
        - a MAP prints as its entries, [{"key": …, "value": …}], and is still a
          MAP: reach into it with attrs['k'] or map_entries(attrs), never with
          list functions
        - DECIMAL, and integers too large for a JSON number, print as quoted
          strings; those columns are still numeric and need no cast

        ${settingsContext}

        Source: ${sourceTableSchema.tableName}  (readable by that name)
        Target: ${targetTableName}  (a table in this workflow's DuckDB database)

        **Instructions**:

        Write ONE SELECT statement that reads from the source and produces the
        transformed result. The rows it returns become the target table — you do
        not write CREATE TABLE, and you do not write an INSERT.

        The target is TRUNCATED AND LOADED on every run: it is replaced
        wholesale by what your SELECT returns, so nothing from a previous run
        survives. Do not try to merge, upsert, or de-duplicate against what was
        there last time, and do not filter rows out on the grounds that an
        earlier run already handled them — the SELECT describes the WHOLE table,
        every time.

        **Important Notes**:
        - Refer to the source by the name above, as if it were a table
        - Column types come from the file; DuckDB infers them, so you do not declare them
        - DuckDB speaks PostgreSQL-flavoured SQL, and adds conveniences worth using:
          SELECT * EXCLUDE (col), SELECT * REPLACE (expr AS col), QUALIFY, GROUP BY ALL
        - Nested values read as STRUCT, LIST or MAP. Reach into them with:
            STRUCT  dot notation      addr.city
            LIST    1-based index     items[1]      (unnest(items) to expand to rows)
            MAP     bracket by key    attrs['color']
          A key/value object becomes a STRUCT when its keys are few and stable, and a
          MAP once there are 200+ distinct keys across the data. The schema above tells
          you which one you have — read it, do not assume.
        - You CANNOT assign to a nested path. \`SET addr.city = 'x'\` is a parser error
          ("Qualified column names in UPDATE .. SET not supported"), and struct_insert
          fails on a key that already exists. To change one field, rebuild the whole value
          and carry every sibling forward — anything you leave out is lost:
            STRUCT  SET addr = struct_pack(city := 'Munich', geo := addr.geo)
            MAP     SET attrs = map_from_entries(list_transform(map_entries(attrs),
                      e -> CASE WHEN e.key = 'color'
                             THEN struct_pack(key := e.key, value := 'blue') ELSE e END))
        - For explanations text to bolden key points use **text** and to break lines use \\n
        - Placeholders like {{current_date}}, {{current_timestamp}} are replaced at runtime

        CRITICAL OUTPUT FORMAT — respond with a SINGLE raw JSON object and NOTHING else. Do not wrap it in markdown code fences, and do not write any text, notes, or commentary before or after the object. Put all explanatory prose inside the JSON's "explanation" field. Any character outside the JSON object will break parsing and cause the request to fail.

        "targetColumns" is every column your SELECT produces, in order — the names it
        actually emits, aliases included. Downstream nodes are configured from this
        list, so a name here that the SELECT does not produce becomes SQL further
        down the pipeline that selects a column nothing has. Write "*" only when the
        SELECT genuinely returns the source unchanged.

        Return your response in exactly this JSON format:
        {
          "explanation": "Brief explanation of the transformation approach",
          "sql": "SELECT statement producing the transformed rows",
          "targetColumns": [{"name": "col", "type": "TYPE"}],
          "previewSql": "The same SELECT with LIMIT 100, for previewing"
        }

        **Examples**:

        Filter and derive a column:
        {
          "explanation": "Keep **active** customers and compute their total spending",
          "sql": "SELECT customer_id, name, email, purchase_count * avg_purchase AS total_spending FROM customers WHERE status = 'active'",
          "targetColumns": [{"name": "customer_id", "type": "INTEGER"}, {"name": "name", "type": "VARCHAR"}, {"name": "email", "type": "VARCHAR"}, {"name": "total_spending", "type": "DOUBLE"}],
          "previewSql": "SELECT customer_id, name, email, purchase_count * avg_purchase AS total_spending FROM customers WHERE status = 'active' LIMIT 100"
        }

        Aggregate — note the columns are the GROUPED shape, not the source's:
        {
          "explanation": "Revenue per city, highest first",
          "sql": "SELECT city, count(*) AS orders, round(sum(amount), 2) AS revenue FROM orders GROUP BY city ORDER BY revenue DESC",
          "targetColumns": [{"name": "city", "type": "VARCHAR"}, {"name": "orders", "type": "BIGINT"}, {"name": "revenue", "type": "DOUBLE"}],
          "previewSql": "SELECT city, count(*) AS orders, round(sum(amount), 2) AS revenue FROM orders GROUP BY city ORDER BY revenue DESC LIMIT 100"
        }

        Drop a column and rename another — "*" is expanded, so list the real result:
        {
          "explanation": "Remove the internal **raw_blob** column and rename **cust_nm**",
          "sql": "SELECT * EXCLUDE (raw_blob), cust_nm AS customer_name FROM orders",
          "targetColumns": [{"name": "order_id", "type": "INTEGER"}, {"name": "amount", "type": "DOUBLE"}, {"name": "customer_name", "type": "VARCHAR"}],
          "previewSql": "SELECT * EXCLUDE (raw_blob), cust_nm AS customer_name FROM orders LIMIT 100"
        }

        Provide working DuckDB SQL.`,

        // `target` is what the statements must address. For a source that is
        // already a table it is that table's name; for a FILE it is the staging
        // table the executor materialises the file into, derived from the node
        // id so both sides agree — pass `{ nodeId }` and it is worked out here,
        // rather than each caller deriving it and risking a mismatch.
        duckdbTransformationInPlace: (settings, sourceTableInfo, settingsContext, sourceTableSchema, target) => `You are a DuckDB expert modifying a local table in place.

        User's transformation request: "${settings.userRequest}"

        ${sourceTableInfo}

        Those sample rows are the output of a DuckDB query, not the raw file or
        document. They show how a value ENCODES on the way into JSON, which is
        not always how it is typed — the Columns list above is what your SQL
        binds against, so trust it over the sample when they disagree:
        - a MAP prints as its entries, [{"key": …, "value": …}], and is still a
          MAP: reach into it with attrs['k'] or map_entries(attrs), never with
          list functions
        - DECIMAL, and integers too large for a JSON number, print as quoted
          strings; those columns are still numeric and need no cast

        ${settingsContext}

        Table: ${resolveInPlaceTable(target, sourceTableSchema)}  (a real table — write statements against it by that name)
        Operation Mode: In-Place (the table is modified where it stands)

        **Instructions**:

        Write the statement — or statements — that make the change the user
        asked for. This is an ordinary DuckDB table, so say what you mean:

        - "delete the cancelled orders" -> DELETE FROM orders WHERE status = 'cancelled';
        - "add a full_name column"      -> ALTER TABLE customers ADD COLUMN full_name VARCHAR;
                                           UPDATE customers SET full_name = first_name || ' ' || last_name;
        - "normalise the emails"        -> UPDATE customers SET email = lower(trim(email));
        - "drop the notes column"       -> ALTER TABLE orders DROP COLUMN notes;
        - "rename cust_nm"              -> ALTER TABLE orders RENAME COLUMN cust_nm TO customer_name;

        Separate multiple statements with semicolons; they run together as one
        unit. Adding a column and populating it is the common two-statement
        case — ALTER first, then UPDATE.

        **Important Notes**:
        - Only what your statements touch changes. Columns and rows you don't
          mention are left exactly as they are
        - Refer to the table by the bare name above — do not qualify it with a
          database or schema
        - Do NOT write a SELECT: a query changes nothing, and the node would
          report success having done nothing at all
        - Do NOT write CREATE TABLE or INSERT — the table already exists
        - Changes are permanent; the previous contents are not kept
        - DuckDB speaks PostgreSQL-flavoured SQL
        - Nested values read as STRUCT, LIST or MAP. Reach into them with:
            STRUCT  dot notation      addr.city
            LIST    1-based index     items[1]      (unnest(items) to expand to rows)
            MAP     bracket by key    attrs['color']
          A key/value object becomes a STRUCT when its keys are few and stable, and a
          MAP once there are 200+ distinct keys across the data. The schema above tells
          you which one you have — read it, do not assume.
        - You CANNOT assign to a nested path. \`SET addr.city = 'x'\` is a parser error
          ("Qualified column names in UPDATE .. SET not supported"), and struct_insert
          fails on a key that already exists. To change one field, rebuild the whole value
          and carry every sibling forward — anything you leave out is lost:
            STRUCT  UPDATE t SET addr = struct_pack(city := 'Munich', geo := addr.geo);
            MAP     UPDATE t SET attrs = map_from_entries(list_transform(map_entries(attrs),
                      e -> CASE WHEN e.key = 'color'
                             THEN struct_pack(key := e.key, value := 'blue') ELSE e END));
        - For explanations text to bolden key points use **text** and to break lines use \\n
        - Placeholders like {{current_date}}, {{current_timestamp}} are replaced at runtime

        CRITICAL OUTPUT FORMAT — respond with a SINGLE raw JSON object and NOTHING else. Do not wrap it in markdown code fences, and do not write any text, notes, or commentary before or after the object. Put all explanatory prose inside the JSON's "explanation" field. Any character outside the JSON object will break parsing and cause the request to fail.

        "targetColumns" is the table's columns AFTER your statements run — downstream
        nodes are configured from it. Use "*" when the shape is untouched (a plain
        UPDATE or DELETE); list every column, not just the new ones, when an ALTER
        adds, drops, or renames any.

        Return your response in exactly this JSON format:
        {
          "explanation": "Brief explanation of what will change and why",
          "sql": "The statement(s) to run, separated by semicolons",
          "targetColumns": [{"name": "col", "type": "TYPE"}],
          "previewSql": "A SELECT showing the table after the change, with LIMIT 100"
        }

        **Examples**:

        Remove rows — shape untouched:
        {
          "explanation": "Delete all **cancelled** orders",
          "sql": "DELETE FROM orders WHERE status = 'cancelled';",
          "targetColumns": "*",
          "previewSql": "SELECT * FROM orders LIMIT 100"
        }

        Add a derived column — every column, not just the added one:
        {
          "explanation": "Add **full_name**, combining first and last names",
          "sql": "ALTER TABLE customers ADD COLUMN full_name VARCHAR; UPDATE customers SET full_name = first_name || ' ' || last_name;",
          "targetColumns": [{"name": "customer_id", "type": "INTEGER"}, {"name": "first_name", "type": "VARCHAR"}, {"name": "last_name", "type": "VARCHAR"}, {"name": "full_name", "type": "VARCHAR"}],
          "previewSql": "SELECT * FROM customers LIMIT 100"
        }

        Rewrite a column in place:
        {
          "explanation": "Normalise **email** to lowercase",
          "sql": "UPDATE customers SET email = lower(trim(email));",
          "previewSql": "SELECT email FROM customers LIMIT 100"
        }

        Change one field inside a nested value (rebuild it, siblings and all):
        {
          "explanation": "Set **customer.address.city** to Munich, leaving the rest of the address alone",
          "sql": "UPDATE orders SET customer = struct_pack(\\"name\\" := customer.name, address := struct_pack(city := 'Munich', geo := customer.address.geo)) WHERE id = 1;",
          "previewSql": "SELECT customer.address.city, customer.address.geo FROM orders LIMIT 100"
        }

        Provide working DuckDB SQL.`,

        transformationRequest: (userRequest, sourceTablesInfo, dbyType, isSourceLocal = false, availableSkills = [], defaultSchema = null) => `You are an intelligent data transformation assistant. Analyze the user's request and determine the best course of action.

        User's request: "${userRequest}"

        Available source data:
        ${sourceTablesInfo}

        Database type: ${dbyType}
        ${isSourceLocal ? 'Source data location: Local file (data is already stored locally)' : 'Source data location: Database (remote connection)'}${defaultSchema ? `
        Default destination schema: ${defaultSchema}` : ''}

        ${availableSkills.length > 0 ? `**Available Skills**:
You have access to these special transformation skills that can be used instead of standard SQL/NoSQL transformations:

${availableSkills.map(skill => `
**${skill.name}** (${skill.id}):
${skill.description.description}

Capabilities:
${skill.description.capabilities.map(cap => `- ${cap}`).join('\n')}

Use when:
- ${skill.description.description}

${skill.prompts ? skill.prompts.systemContext : ''}
`).join('\n')}

**IMPORTANT**: If a skill is better suited for the transformation than standard SQL/NoSQL, you can specify "usesSkill": true and "skillId": "<skill-id>" in your response.
` : ''}

        **Important**: You have access to the full chat history. Use it to understand:
        - If this is a follow-up request (refine/modify existing transformation)
        - If this is a new transformation request
        - If the user is asking a question about existing transformation
        - Previous transformation settings and SQL/code that was generated

        Your task is to analyze this request and determine:

        1. **Action Type**: What should happen next? There are exactly TWO, and every
           request ends in one of them — you either build, or you ask.
           - "generate_transformation": If the instructions are clear and there are no follow up questions (questionsNeeded in JSON response) required to ask the user and transformation can be written
           - "ask_questions": ANYTHING else. Need to ask clarifying questions to determine transformation settings (use questionsNeeded to specify clarifications)
           You are a builder, not a chat partner: you do not answer questions as an
           end in itself. When the user asks one ("what columns are available?"), or
           when you cannot do what was asked (the named table is not in the source
           data above, the request contradicts the schema), that is "ask_questions" —
           put what you know, and what you need, in questionsNeeded. NEVER report a
           request as impossible in a way that looks like a finished node: silently
           leaving the node as it was is how a transformation written for a previous
           source survives onto a new one and fails at run time.

        2. **Inferred Settings**: Based on the request, what transformation settings can you determine based on users input? Do not infer settings unless specified by the users input.
           - operationMode: "new_table" (creating new dataset) or "in_place" (updating/deleting existing records) or null if unclear${isSourceLocal ? '' : `
           - storageLocation: "database" (store/process in database) or "local" (store/process locally) or null if unclear
           - **CONSTRAINT**: If storageLocation is inferred as "local", automatically set operationMode to "new_table" (cannot do in-place on remote database while storing locally)`}

        3. **Questions Needed**: Which settings are ambiguous and need clarification?
           - Return object of setting names that need to be answered by user that are not infered by the user already
           - Only include settings that are ambiguous based on the request and need to be determined for the type of transformation
           - For each setting that needs clarification, provide a question that would be relevant towards the users input
           - Do not infer anything about the output format or any additional steps outside the scope of the singular transformation step to update/delete/create from the source
           - Do not impose questions if they are already infered from the user input${isSourceLocal ? '' : `
           - "Local" storage means a file on this machine, queried with DuckDB. Tabular and document data are handled the same way — there is no separate store to choose
           - If the storage location of the data is local and the source is a database, then by default a new local dataset is created`}

           **Dynamic Question Logic**: The follow up questions should follow this logic if they are not answered already in users input
            - If an update statement is the direct choice and user hasn't provided input on if they want to update the source table or create a new temporary table for this update
            - For filtering/deleting records, do they want to do it in source table or create a new table with filtered data${isSourceLocal ? '' : `
            - For in place transformations, the storage location (storageLocation) would be the database
            - If a transformation needs to create a new table, where should the data be stored: in the database or locally
            - **IMPORTANT**: If storageLocation is "local", then operationMode MUST always be "new_table" (database-to-local transformations cannot be in-place)`}

        4. tableName: the output table/collection name, and nothing else — never
           schema-qualified. Where a request names the table with a schema in
           front of it, return only the table part${defaultSchema ? '; the schema is its own field (see 5)' : ''}.
           - If the user named one ("save to customer_data", "create orders_2024 table"), use it verbatim.
           - Otherwise, for operationMode "new_table", COIN a short snake_case name
             describing what the result CONTAINS — "denied_stores", "orders_2024",
             "customers_with_totals". This name becomes the node's label on the
             canvas, so it has to read as English, not as an identifier: no node
             ids, no timestamps, no "transformer_" prefix, 2-3 words at most.
           - Only for operationMode "in_place" is null right: an in-place update
             writes back to the source, which already has a name.
           - Say which it is in tableNameFromUser. A coined name gets a short
             suffix from the node id added by the app, so it is unique; never add
             one yourself.${defaultSchema ? `

        5. schema: which schema the output table lives in. The default is
           ${defaultSchema} — return that unless the user asked for another one.` : ''}


        Examples:
        - Request: "What columns are in the orders table?" → ask_questions (name the columns in the question text, then ask what they want done with them)
        - Request: "I want to transform the data" → ask_questions (ask the user to provide the logic they want)
        - Request names a table that is not in the source data above → ask_questions (say which table you were given, and ask which one to use)${isSourceLocal ? `
        - Request: "Can you update column A in the table directly?" → generate_transformation (operationMode: in_place)
        - Request: "Create a new table with filtered customers" → generate_transformation (operationMode: new_table — a local source has no storage location to ask about)` : `
        - Request: "Can you update column A in the table directly?" → generate_transformation (operationMode: in_place, storageLocation: database)
        - Request: "Create a new table with filtered customers" → ask_questions (clear: operationMode is new_table, but unclear: storage location)
        - Request: "Save filtered customers locally" → generate_transformation (operationMode: new_table, storageLocation: local - ALWAYS new_table for local storage)`}

        Notes:
        - For explanations text to bolden key points use **text** and to break lines use \\n
        - Placeholders like {{current_date}}, {{current_timestamp}} will be replaced at runtime
        - current application execution plan injects $out into statement and takes care of deleting collection if it needs to be replaced for new_table
        - Do not include any additional keys in the response

        CRITICAL OUTPUT FORMAT — respond with a SINGLE raw JSON object and NOTHING else. Do not wrap it in markdown code fences, and do not write any text, notes, explanation, or corrected SQL before or after the object. If you need to explain something to the user, answer a question, correct/diagnose SQL, or say why you cannot proceed, put that text inside a "questionsNeeded" entry and set "action" to "ask_questions" — never write prose outside the JSON. Any character outside the JSON object will break parsing and cause the request to fail.

        Return your response as JSON:
        {
          "action": "generate_transformation" | "ask_questions",
          "tableName": "the table name ONLY, never schema-qualified — the user's name, or a short snake_case name you coin for a new table (null only for in_place)",
          "tableNameFromUser": true | false (true ONLY when the user's own words name the output table; false when you coined it),${defaultSchema ? `
          "schema": "the schema the output table lives in (default ${defaultSchema})",` : ''}
          "usesSkill": false | true,
          "skillId": "skill-id-here (only if usesSkill is true)",
          "skillExplanation": "Brief explanation of why this skill is being used (only if usesSkill is true)",
          "inferredSettings": {
            "operationMode": "new_table" | "in_place" | null${isSourceLocal ? '' : `,
            "storageLocation": "database" | "local" | null`}
          },
          "questionsNeeded": {
            "operationMode": "If the operation type is not infered by the users input then provide context-specific question about operation mode based on user request else don't include this key"${isSourceLocal ? '' : `,
            "storageLocation": "If the storage is not infered by users input then provide context-specific question about storage location based on user request else don't include this key"`}
          }
        }

        Only ask questions that are truly needed.`
    }
}

module.exports = prompts;
module.exports.default = prompts;