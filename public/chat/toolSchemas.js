/**
 * Provider-neutral JSON Schema tool definitions for the chat assistant.
 *
 * These mirror the tool contract written in prose inside the `main` and
 * `workflow` prompts (see chat/prompts.js). The prose stays the long-form
 * source of truth —
 * it is still sent as the system prompt on both paths, and the JSON-in-text
 * fallback (local models, unknown OpenAI-compatible endpoints) has nothing else
 * to go on. What lives here is the machine-checkable part: names, argument
 * shapes, required fields, and the one or two constraints a model most often
 * gets wrong (read-only, row caps, "call this one alone").
 *
 * Keep the two in sync when a tool's arguments change. `assertSchemasMatch` in
 * chatAssistant wires the name sets together so a tool added to one registry
 * and not the other fails loudly at startup rather than silently going missing
 * from the model's toolbox.
 */

const MAX_QUERY_ROWS = 50;

// ── Read-only inspection, shared by both agent modes ───────────────────────
const DOC_TOOLS = [
  {
    name: 'list_docs',
    description: 'List the available documentation files. Cheap; call before read_doc if unsure of a path.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'read_doc',
    description: 'Read one documentation file by its path, as returned by list_docs.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Path relative to the docs root, e.g. "nodes/join.md".' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
];

const WORKFLOW_READ_TOOLS = [
  {
    name: 'list_workflows',
    description: 'Summaries of every saved workflow: id, name, node count, last run.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_workflow',
    description: 'One workflow\'s slimmed configuration. Large workflows come back as an outline of '
      + 'node ids, types and one-line descriptions — follow up with get_workflow_nodes for detail.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Workflow id.' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_workflow_nodes',
    description: 'Full slimmed config for specific nodes of one workflow. Use after a trimmed '
      + 'get_workflow. Pass only the ids you actually need — every extra id costs tokens.',
    input_schema: {
      type: 'object',
      properties: {
        workflowId: { type: 'string' },
        nodeIds: { type: 'array', items: { type: 'string' }, minItems: 1 },
      },
      required: ['workflowId', 'nodeIds'],
      additionalProperties: false,
    },
  },
];

const CONNECTION_TOOLS = [
  {
    name: 'list_connections',
    description: 'Every saved connection: id, name, dbType, dbCategory, connectionType, and the tables it owns.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_connection',
    description: 'Metadata for one connection, by id or name. Secrets are stripped.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Connection id or name.' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_tables',
    description: 'List tables/collections in a saved connection.',
    input_schema: {
      type: 'object',
      properties: { connection: { type: 'string', description: 'Connection id or name.' } },
      required: ['connection'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_columns',
    description: 'List columns of a table. If the connection owns exactly one table, `table` may be omitted.',
    input_schema: {
      type: 'object',
      properties: {
        connection: { type: 'string' },
        table: { type: 'string' },
        schema: { type: 'string' },
      },
      required: ['connection'],
      additionalProperties: false,
    },
  },
  {
    name: 'run_query',
    description: 'Run a READ-ONLY query against a saved connection and return rows. '
      + 'SELECT / WITH…SELECT / SHOW / EXPLAIN / DESCRIBE, Mongo find/count/aggregate without $out|$merge, '
      + 'LanceDB / Pinecone list, count, query (similarity) and fetch. '
      + 'Anything that modifies data is blocked — to change data, hand off with plan_workflow_build. '
      + `Capped at ${MAX_QUERY_ROWS} rows; add LIMIT to the query too, and COUNT first when a result may be large. `
      + 'The table name is NOT the connection name: use the connection\'s "tables" entry, or call get_tables.',
    input_schema: {
      type: 'object',
      properties: {
        connection: { type: 'string', description: 'Connection id or name.' },
        query: {
          type: 'string',
          description: 'SQL string; or JSON text for MongoDB, LanceDB and Pinecone. '
            + 'LanceDB: {"operation":"count"|"list","tableName":"<table>","filter"?:"<SQL where>","limit"?:n} '
            + 'or {"operation":"query","tableName","queryVector":[...],"topK"?:n}. '
            + 'Pinecone: {"operation":"count","indexName","namespace"?} — the namespace record count — '
            + 'or {"operation":"list","indexName","namespace"?,"limit"?:n,"filter"?} to show records (no vector needed) '
            + 'or {"operation":"fetch","indexName","namespace"?,"ids":[...]} / {"operation":"query",...,"queryVector":[...]} (similarity).',
        },
        limit: { type: 'number', description: `Row cap, at most ${MAX_QUERY_ROWS}.` },
      },
      required: ['connection', 'query'],
      additionalProperties: false,
    },
  },
];

const EXECUTION_TOOLS = [
  {
    name: 'list_executions',
    description: 'Recent execution summaries, newest first.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Default 20, max 50.' },
        workflowId: { type: 'string', description: 'Restrict to one workflow.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_execution',
    description: 'One execution document in full, including its logs.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Execution id.' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
];

// Offered to the main agent as an "act/compute" tool, and to the workflow
// sub-agent for ONE job: calling an API before a plan is proposed, so the
// planner knows the response shape instead of guessing at it. Declared on its
// own so the workflow toolbox can take this without taking http_request —
// which cannot authenticate, and so cannot probe most real endpoints.
const RUN_JAVASCRIPT_TOOL = {
  name: 'run_javascript',
  description: 'Generate a one-off async JavaScript function for logic run_query and http_request '
    + 'cannot express — per-row AI calls, embeddings, orchestrating several connections, or calling an API '
    + 'that needs saved credentials. The user reads the code and approves it before it runs; it then runs '
    + 'with ctx helpers (runQuery — read-only here, askAi, vectorize, axios, '
    + 'getTables, getColumns, apiCredentials, log); its returned array comes back as `rows`, capped at '
    + `${MAX_QUERY_ROWS}. This computes an answer to SHOW; it saves nothing — `
    + 'to build a saved transformer node use plan_workflow_build instead. Sample rows rather than looping over '
    + 'everything: ctx.askAi and ctx.axios cost money and rate-limit. If `ran` is false the generator needs '
    + 'clarification (see `questionsNeeded`) — ask the user rather than retrying blindly.',
  input_schema: {
    type: 'object',
    properties: {
      request: { type: 'string', description: 'Plain-English description of what the function must do.' },
      source: {
        type: 'object',
        description: 'Optional table to load as the function\'s `records` input. Omit to start from an empty '
          + 'array and have the function fetch what it needs itself.',
        properties: { connection: { type: 'string' }, table: { type: 'string' } },
        additionalProperties: false,
      },
    },
    required: ['request'],
    additionalProperties: false,
  },
};

const EXTERNAL_TOOLS = [
  {
    name: 'http_request',
    description: 'Fetch a URL and return { status, statusText, headers, data }. Takes a URL and a method — '
      + 'nothing else: no headers, no query-parameter object, no body. Put anything the URL needs in the URL '
      + 'itself. Non-2xx responses are RETURNED, not thrown, so you can read the status and react. '
      + 'This tool CANNOT authenticate: it has no access to saved credentials and you must never invent a '
      + 'token or key. If the endpoint needs an API key, token, or any other credential the user saved on a '
      + 'connection, use run_javascript instead — the generated function resolves them via ctx.apiCredentials '
      + 'at run time. Request narrowly (large bodies get truncated), leave a gap between calls, and never '
      + 'hammer an endpoint.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'], default: 'GET' },
        timeout: { type: 'number', description: 'Milliseconds.' },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  RUN_JAVASCRIPT_TOOL,
];

// ── Main-agent only ────────────────────────────────────────────────────────
const MAIN_ONLY_TOOLS = [
  {
    name: 'build_presentation',
    description: 'Build a dashboard presentation (KPIs, charts and written findings the user opens full-screen) '
      + 'from saved data. Use it ONLY when the user explicitly asks for a presentation, dashboard, report or '
      + 'deck — answer ordinary questions with run_query / run_javascript and "visuals" instead. Two calls: '
      + 'first { request } alone — it asks the user clarifying questions and ends your turn with them. After the '
      + 'user replies, call again with the same request and `answers` set to the user\'s reply, verbatim. '
      + 'Never fill in `answers` yourself. That second call writes an analysis function the user approves '
      + 'before it runs; the presentation is then attached to your answer. Reply with a short summary of the '
      + 'findings and do not add "visuals". To change an existing presentation, call again with the request '
      + 'restated to include the change.',
    input_schema: {
      type: 'object',
      properties: {
        request: { type: 'string', description: 'What the presentation is about, from the user\'s message.' },
        answers: { type: 'string', description: 'The user\'s reply to the clarifying questions, verbatim. '
          + 'Omit on the first call.' },
      },
      required: ['request'],
      additionalProperties: false,
    },
  },
  {
    name: 'plan_workflow_build',
    description: 'TRIGGER — hands control to the workflow-builder sub-agent from the next turn onward. '
      + 'Call it when the user wants to CREATE or MODIFY a workflow. Call it EXACTLY ONCE and ALONE: never '
      + 'alongside another tool in the same turn, and never twice for one request. If you still need a tool '
      + 'result first (get_workflow to confirm the target, say), run that this turn and call this next turn. '
      + 'Do not answer the user on the turn you call it — an answer ends the turn without running the tool, '
      + 'so the build would never start. Set `workflowId` only for modify intent; when the target is ambiguous, '
      + 'ask one short clarifying question first.',
    input_schema: {
      type: 'object',
      properties: {
        request: { type: 'string', description: 'Short description of the workflow wanted. The user\'s full '
          + 'message is forwarded automatically, so literal URLs, bodies, tokens and keys need not be copied.' },
        workflowId: { type: 'string', description: 'Only for modify intent.' },
      },
      required: ['request'],
      additionalProperties: false,
    },
  },
  {
    name: 'generate_workflow_validation',
    description: 'Author (or re-author) an output-validation function for a saved workflow — a conservative '
      + 'async validate(ctx) that runs at the end of every execution and reports valid, or a reason it is not. '
      + 'Use when the user wants the workflow to check its own output. Returns { generated, goal, explanation }; '
      + 'relay the goal and explanation so the user knows what will be checked.',
    input_schema: {
      type: 'object',
      properties: { workflowId: { type: 'string' } },
      required: ['workflowId'],
      additionalProperties: false,
    },
  },
];

// ── Focused-node tools (offered only when a node is selected on the canvas) ──
const BUILD_TOOL_DESCRIPTIONS = {
  build_transformer: 'Build, change, fix or refine the Transformer node currently in focus.',
  build_join: 'Build, change, fix or refine the Join node currently in focus.',
  build_dataSource: 'Build, change, fix or refine the REST API Data Source node currently in focus.',
};

function buildToolSchema(name) {
  return {
    name,
    description: `${BUILD_TOOL_DESCRIPTIONS[name] || 'Build the node currently in focus.'} `
      + 'Takes no arguments: the builder reads the user\'s message verbatim and the node\'s own chat history, '
      + 'so never restate or translate what the user said. Route here for real build/change work on this node, '
      + 'and when the user is answering a question the builder asked. Do NOT route here for questions you can '
      + 'answer yourself about what the node currently does — read its config and the read-only tools instead. '
      + 'Success is { built: true, summary }.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  };
}

const NODE_CONTEXT_SCHEMA = {
  name: 'add_node_context',
  description: 'Record a fact the node builder will need later. The builder cannot see this conversation — only '
    + 'the node\'s own transcript — so when you answer the user yourself and establish something that changes what '
    + 'the builder would produce (a schema you looked up, a table the user named, a rule they stated), write it '
    + 'down here in the same turn. State it plainly and completely; "as discussed above" is useless to the builder. '
    + 'It writes a note and nothing else — carry on answering the user in the same turn.',
  input_schema: {
    type: 'object',
    properties: { note: { type: 'string', description: 'One or two sentences of fact.' } },
    required: ['note'],
    additionalProperties: false,
  },
};

// Offered only while the focused Join node has no destination yet. A join that
// does not know where it writes cannot be built at all, so this is the one tool
// that has to run before build_join will do anything.
const JOIN_DESTINATION_SCHEMA = {
  name: 'set_join_destination',
  description: 'Record where the focused Join node writes its result. The join cannot be built until this is set, '
    + 'so if the user asks to configure the join and has not said where the output goes, ask them — list the '
    + 'destinations from the node-in-focus section — and call this once they name one. Accepts a saved connection '
    + 'id or name, "local-duckdb" for a local table in the workflow\'s DuckDB database, or "local-lancedb" '
    + 'for a local LanceDB vector table (only when the user wants the result stored as vectors).',
  input_schema: {
    type: 'object',
    properties: {
      destination: {
        type: 'string',
        description: 'A saved connection id or name, "local-duckdb" for a local DuckDB table, or '
          + '"local-lancedb" for a local LanceDB vector table.',
      },
    },
    required: ['destination'],
    additionalProperties: false,
  },
};

// ── Workflow sub-agent only ────────────────────────────────────────────────
const WORKFLOW_ONLY_TOOLS = [
  {
    name: 'propose_plan',
    description: 'Run the workflow planner and present its plan to the user. This ends your turn — the plan card '
      + 'is shown directly, so do not try to relay it. Give `workflowId` to modify an existing workflow, or '
      + '`newWorkflow: true` to build a fresh one.',
    input_schema: {
      type: 'object',
      properties: {
        request: { type: 'string', description: 'Self-contained description of the workflow the user currently '
          + 'wants, synthesized from the conversation so far.' },
        workflowId: { type: 'string', description: 'Modify this workflow.' },
        newWorkflow: { type: 'boolean', description: 'Build a brand-new workflow, ignoring any open one.' },
      },
      required: ['request'],
      additionalProperties: false,
    },
  },
  {
    name: 'exit_workflow_mode',
    description: 'Hand control back to the main assistant — the user accepted or cancelled the plan, or changed '
      + 'the subject to something that is not workflow building.',
    input_schema: {
      type: 'object',
      properties: { reason: { type: 'string', description: 'One line: why you are handing back.' } },
      required: ['reason'],
      additionalProperties: false,
    },
  },
];

// ── Terminal tool ──────────────────────────────────────────────────────────
// Replaces schema B of the JSON contract. A model with native tool calling ends
// its turn by emitting text and no tool calls; that works for prose but loses
// the structured `visuals` array, so answering is itself a tool. The loop treats
// this one as terminal and never executes it.
const VISUAL_SCHEMA = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['bar', 'line', 'pie', 'scatter', 'kpi', 'table'] },
    title: { type: 'string' },
    source: { type: 'string', description: 'Reference to a prior result, "<step>.<action>" — e.g. "3.1".' },
    x: { type: 'string', description: 'Column name for the x axis. Required with `source`.' },
    y: { type: 'string', description: 'Column name for the y axis. Required with `source`.' },
    dataset: {
      type: 'array',
      // Chart types are validated at resolve time (rows without x/y degrade to
      // a table), so the schema only has to be loose enough for both uses: a
      // chart's { x, y } points, and a table's arbitrary row objects.
      description: 'Inline data instead of `source`. Never provide both. Chart types take '
        + '{ "x": <label>, "y": <number> } per item; a "table" takes any row objects, with '
        + 'the keys you want as columns.',
      items: { type: 'object' },
    },
  },
  required: ['type', 'title'],
};

const FINAL_ANSWER_TOOL = {
  name: 'final_answer',
  description: 'Answer the user and end the turn. Call this alone — never batched with other tools. Rows worth '
    + 'charting go in `visuals`; omit it when nothing is.',
  input_schema: {
    type: 'object',
    properties: {
      answer: { type: 'string', description: 'The reply, in markdown.' },
      visuals: { type: 'array', maxItems: 3, items: VISUAL_SCHEMA },
      // Present only on the first turn of a new chat, and only then does the
      // system prompt ask for it (see chatTitleSection in prompts.js). This is
      // the only place a chat is named; a turn that never reaches a final
      // answer keeps the placeholder title seeded from the user's message.
      title: {
        type: 'string',
        description: 'Only when the system prompt asked you to name this conversation: a 3-5 word, '
          + 'title-case topic name. Omit otherwise.',
      },
    },
    required: ['answer'],
    additionalProperties: false,
  },
};

const MAIN_SCHEMAS = [
  ...DOC_TOOLS,
  ...WORKFLOW_READ_TOOLS,
  ...CONNECTION_TOOLS,
  ...EXECUTION_TOOLS,
  ...EXTERNAL_TOOLS,
  ...MAIN_ONLY_TOOLS,
];

const WORKFLOW_SCHEMAS = [
  ...CONNECTION_TOOLS,
  ...WORKFLOW_READ_TOOLS,
  RUN_JAVASCRIPT_TOOL,
  ...WORKFLOW_ONLY_TOOLS,
];

/**
 * The toolbox for one turn.
 *
 * @param {string} agentMode      'main' | 'workflow'
 * @param {string|null} buildToolName  Focused node's builder, when a node is selected.
 * @param {boolean} joinNeedsDestination  Focused Join has no destination yet.
 * @returns {Array} Tool schemas, always including final_answer.
 */
function toolsForTurn(agentMode, buildToolName = null, joinNeedsDestination = false) {
  const base = agentMode === 'workflow' ? [...WORKFLOW_SCHEMAS] : [...MAIN_SCHEMAS];
  // Only the focused node type's builder is offered, mirroring focusedBuildTool.
  if (agentMode !== 'workflow' && buildToolName) {
    base.push(buildToolSchema(buildToolName), NODE_CONTEXT_SCHEMA);
    if (joinNeedsDestination) base.push(JOIN_DESTINATION_SCHEMA);
  }
  base.push(FINAL_ANSWER_TOOL);
  return base;
}

module.exports = {
  toolsForTurn,
  FINAL_ANSWER_TOOL,
  MAIN_SCHEMAS,
  WORKFLOW_SCHEMAS,
};
