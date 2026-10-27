/**
 * Python Executor Skill Plugin for Ternlux
 * Allows executing Python code directly on the local machine for transformations
 */

const { spawn, execFile } = require('child_process');
const fs = require('fs').promises;
const { existsSync } = require('fs');
const path = require('path');
const os = require('os');

/**
 * The user's own Python 3, as [command, ...args], or null.
 *
 * A packaged app launched from the Dock inherits launchd's bare PATH, so a
 * plain `python3` misses Homebrew and python.org installs — and on macOS it
 * lands on /usr/bin/python3, a stub that pops the developer-tools installer
 * when the Command Line Tools are absent. So ask the login shell first (it
 * sees the user's real PATH, and with it their global packages), then try
 * the usual install locations. Only a hit is cached, so installing Python
 * takes effect without restarting the app.
 */
let foundPython = null;

function isPython3(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, [...args, '-c', 'import sys; sys.exit(sys.version_info[0] != 3)'],
      { timeout: 10000, windowsHide: true }, (err) => resolve(!err));
  });
}

function loginShellPython() {
  return new Promise((resolve) => {
    execFile(process.env.SHELL || '/bin/sh', ['-ilc', 'command -v python3'],
      { timeout: 5000 }, (err, stdout) => {
        const line = String(stdout || '').trim().split('\n').pop() || '';
        resolve(!err && line.startsWith('/') ? line : null);
      });
  });
}

async function findPython() {
  if (foundPython) return foundPython;
  const candidates = process.platform === 'win32'
    ? [['py', '-3'], ['python']]
    : [[await loginShellPython()], ['/opt/homebrew/bin/python3'],
      ['/usr/local/bin/python3'], ['/usr/bin/python3']];
  // Apple's /usr/bin/python3 is only real once developer tools are installed.
  const appleStub = (cmd) => process.platform === 'darwin' && cmd === '/usr/bin/python3'
    && !existsSync('/Library/Developer/CommandLineTools/usr/bin/python3')
    && !existsSync('/Applications/Xcode.app/Contents/Developer/usr/bin/python3');
  for (const [cmd, ...args] of candidates) {
    if (cmd && !appleStub(cmd) && await isPython3(cmd, args)) {
      return (foundPython = [cmd, ...args]);
    }
  }
  return null;
}

const INSTALL_PYTHON = {
  win32: 'winget install Python.Python.3.12',
  darwin: 'brew install python   (or the installer from https://www.python.org/downloads/)',
  linux: 'sudo apt install python3 python3-pip',
};

// Import name -> pip name, where they differ.
const PIP_NAMES = {
  sklearn: 'scikit-learn', dateutil: 'python-dateutil', yaml: 'pyyaml',
  PIL: 'pillow', cv2: 'opencv-python', bs4: 'beautifulsoup4',
};

function shellCommand(parts) {
  return parts.map((p) => (/\s/.test(p) ? `"${p}"` : p)).join(' ');
}

/**
 * The JSON object in a model reply.
 *
 * The skill turn is not made in JSON mode, so models routinely wrap the object
 * in a ```json fence or put a sentence in front of it. A bare JSON.parse turned
 * every one of those into "I had trouble understanding", and the builder then
 * re-asked the same thing round after round. Take the fenced body when there
 * is one, else the first balanced {...} (string-aware, so braces inside the
 * Python code do not end it early).
 */
function parseModelJson(text) {
  if (text && typeof text === 'object') return text;
  const raw = String(text || '').trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1].trim() : raw;
  try { return JSON.parse(body); } catch (_) { /* fall through to extraction */ }
  let depth = 0; let start = -1; let inString = false; let escape = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') { if (depth === 0) start = i; depth++; }
    else if (ch === '}' && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) return JSON.parse(body.slice(start, i + 1));
    }
  }
  throw new Error('No JSON object found in the response');
}

module.exports = {
  type: 'skill',
  id: 'python-executor',
  name: 'Python Executor',
  icon: './icon.svg',
  category: 'transformer', // Can be 'transformer', 'join', or 'both'
  supportsInteraction: true, // This skill can ask follow-up questions

  /**
   * Get skill description for AI context
   */
  getDescription: () => {
    return {
      name: 'Python Executor',
      description: 'Execute Python code directly on the local machine. Use this when the transformation requires complex data manipulation, scientific computing, or when Python libraries (pandas, numpy, etc.) would be beneficial. The Python code receives input data and must return transformed data.',
      capabilities: [
        'Execute arbitrary Python code',
        'Access to pandas, numpy, and other Python libraries',
        'Complex data transformations',
        'Statistical analysis',
        'Machine learning operations',
        'Custom business logic'
      ],
      inputFormat: 'Array of objects or single object',
      outputFormat: 'Array of objects or single object',
      executionEnvironment: 'local'
    };
  },

  /**
   * Main function to handle all Python skill interactions
   * Returns a prompt for the AI to process
   * @param {Object} params - Request parameters
   * @param {String} params.userRequest - Current user request
   * @param {Array} params.chatHistory - Conversation history
   * @param {Object} params.sourceTableSchema - Source data schema
   * @param {String} params.operationType - 'sql' or 'nosql'
   * @param {Object} params.settings - Current transformation settings
   * @param {Object} params.currentState - Current skill state (pythonCode, etc.)
   * @returns {Object} Prompt to execute
   */
  buildSkillPrompt: (params) => {
    const { userRequest, sourceTableSchema, operationType = 'sql', settings = {}, currentState = {} } = params;

    // Build the main prompt for a new-table transformation
    const sourceTableInfo = `
Source: ${sourceTableSchema.sourceNodeLabel || 'Unknown'}
- Table/Collection name: ${sourceTableSchema.tableName}
- Columns/Fields: ${JSON.stringify(sourceTableSchema.columns || [])}
- Sample data (first 5 rows/documents): ${JSON.stringify(sourceTableSchema.sampleData || [])}
    `;

    const outputGuidance = operationType === 'sql'
      ? 'Output must be a list of dictionaries with consistent schema (all records have the same keys)'
      : 'Output can be a list of dictionaries with varying schemas (documents can have different fields)';

    const prompt = `You are a Python transformation expert using pandas and numpy.

Database Type: ${operationType === 'sql' ? 'SQL (Structured)' : 'NoSQL (Document-based)'}
User's request: "${userRequest}"

${sourceTableInfo}

Target Collection/Table: ${settings.tableName || 'transformed_data'}
Storage Location: ${settings.storageLocation || 'local'}
Available Libraries: pandas, numpy

**Your Task**:
Analyze the user's request and determine the appropriate action:

1. **unrelateSkill** - If the request is:
   - Not related to Python/pandas transformation
   - Asking about the data source (not transformation)
   - General questions about the workflow
   - Requesting a different type of operation

2. **ask_questions** - Everything short of executing. Use it if you need:
   - More details about the transformation logic
   - Clarification on column names or operations
   - User preferences for handling edge cases
   - To answer a question about the code you already wrote, or about what it
     does — answer it inside followUpQuestion, then say what you still need
   - To report something you cannot do (a column that is not in the source)
   You are a builder, not a chat partner: apart from unrelateSkill, executing and
   asking are the only two ways this ends.

3. **execute** - When you're ready to execute:
   - User has provided all necessary information
   - You have complete Python transformation code
   - Code includes a transform(data) function

**Python Code Requirements**:
- Must define: \`def transform(data):\`
- Function receives: List of dictionaries (each dict is a row/document)
- Function returns: List of dictionaries (transformed data)
- Use pandas for data manipulation: \`df = pd.DataFrame(data)\`
- Return format: \`return df.to_dict('records')\`
- ${outputGuidance}
- Only import pandas and numpy (import pandas as pd, import numpy as np)

**Example Transformation**:
\`\`\`python
import pandas as pd
import numpy as np

def transform(data):
    # Convert to DataFrame
    df = pd.DataFrame(data)

    # Your transformation logic
    df['new_column'] = df['existing_column'] * 2

    # Return as list of dicts
    return df.to_dict('records')
\`\`\`

${currentState.pythonCode ? `\n**Current Python Code**:\n\`\`\`python\n${currentState.pythonCode}\n\`\`\`\n` : ''}

Return your response in JSON format:
{
  "action": "unrelateSkill" | "ask_questions" | "execute",
  "pythonCode": "Complete Python code (ONLY if action is 'execute')",
  "targetColumns": [{"name": "col", "type": "TYPE"}],   // ONLY if action is 'execute': every column the code RETURNS, in order. Downstream nodes are configured from this, so it must match what transform() actually emits — "*" only if the shape is unchanged from the source
  "explanation": "Explanation of what you're doing or asking",
  "followUpQuestion": "Question for user (ONLY if action is 'ask_questions')",
  "reasoning": "Why you chose this action"
}`;

    // Return prompt for the chat component to execute
    return {
      prompt,
      context: {
        userRequest,
        sourceTableSchema,
        operationType
      }
    };
  },

  /**
   * Process the AI response
   * @param {String} aiResponse - Raw AI response
   * @param {String} operationType - 'sql' or 'nosql'
   * @returns {Object} Processed action
   */
  processSkillResponse: (aiResponse, operationType = 'sql') => {
    let analysis;
    try {
      analysis = parseModelJson(aiResponse);
    } catch (e) {
      console.error('[Python Executor] Failed to parse response:', e);
      return {
        action: 'ask_questions',
        followUpQuestion: 'I had trouble understanding. Could you please rephrase your transformation request?',
        explanation: 'Failed to parse AI response'
      };
    }

    // Validate and return the action
    if (analysis.action === 'execute') {
      // Validate Python code
      if (!analysis.pythonCode || !analysis.pythonCode.includes('def transform(')) {
        return {
          action: 'ask_questions',
          followUpQuestion: 'The Python code must include a `transform(data)` function. Please provide complete code.',
          explanation: 'Missing transform function'
        };
      }

      return {
        action: 'execute',
        pythonCode: analysis.pythonCode,
        // Declared output shape — the builder records it as the node's
        // targetTableSchema when it cannot describe the result for real.
        targetColumns: analysis.targetColumns ?? null,
        explanation: analysis.explanation,
        operationType
      };
    }

    return analysis;
  },

  /**
   * Get prompts to add to transformation requests
   * This helps the AI understand it can use Python
   * @param {Object} context - Context information
   * @param {String} context.operationType - 'sql' or 'nosql'
   * @param {Object} context.sourceSchema - Source data schema
   */
  getTransformPrompts: (context = {}) => {
    const { operationType = 'sql', sourceSchema = {} } = context;

    const outputGuidance = operationType === 'sql'
      ? `
**IMPORTANT - SQL Output Format**:
- Return data as a list of dictionaries with consistent schema
- All records must have the same keys
- Use consistent data types for each column
- Example: [{"id": 1, "name": "John"}, {"id": 2, "name": "Jane"}]
`
      : `
**IMPORTANT - NoSQL Output Format**:
- Return data as a list of dictionaries (documents)
- Documents can have varying schemas
- Nested objects and arrays are allowed
- Example: [{"_id": "1", "data": {"nested": "value"}}, {"_id": "2", "tags": ["a", "b"]}]
`;

    return {
      systemContext: `
You have access to a Python Executor skill that can run Python code directly on the local machine.

**IMPORTANT**: The user must explicitly request Python or mention pandas/numpy for this skill to be used.
DO NOT use this skill unless the user specifically asks for:
- "use Python"
- "use pandas"
- "with pandas/numpy"
- Python-specific operations

When Python Executor is appropriate:
- User explicitly requested Python/pandas/numpy
- Complex data transformations requiring Python libraries
- Statistical analysis or machine learning operations
- Custom business logic that's too complex for SQL

${outputGuidance}

Available Libraries: pandas, numpy (only these two are available)

Python Code Requirements:
- Must define a function called 'transform(data)'
- The function receives data as a list of dictionaries
- The function must return a list of dictionaries matching the output format above
- Can only import pandas and numpy
- Handle errors gracefully

Example Python transformation:
\`\`\`python
import pandas as pd
import numpy as np

def transform(data):
    # Convert to DataFrame
    df = pd.DataFrame(data)

    # Perform transformation
    df['new_column'] = df['existing_column'] * 2
    df['calculated'] = df['value1'] + df['value2']

    # Return as list of dicts
    return df.to_dict('records')
\`\`\`
`,
      responseFormat: `
**Using Python Executor Skill**:
Only if user explicitly requested Python, return JSON:
{
  "usesSkill": true,
  "skillId": "python-executor",
  "skillParams": {
    "pythonCode": "Complete Python code with transform function"
  },
  "explanation": "Brief explanation of the transformation"
}

Otherwise use standard SQL/NoSQL transformation.
`
    };
  },

  /**
   * Analyze a request and determine if this skill should be used
   * This is called when AI indicates this skill should be used
   *
   * @param {Object} params - Analysis parameters
   * @param {String} params.userRequest - Original user request
   * @param {Object} params.skillParams - Parameters from AI response
   * @param {Object} params.sourceSchema - Source data schema
   * @param {Array} params.chatHistory - Conversation history
   * @param {String} params.operationType - 'sql' or 'nosql'
   * @returns {Promise<Object>} Analysis result
   */
  analyzeRequest: async (params) => {
    const { skillParams, sourceSchema, operationType = 'sql' } = params;

    // Check if we have Python code
    if (!skillParams || !skillParams.pythonCode) {
      return {
        action: 'ask_questions',
        followUpQuestion: 'Please provide the Python transformation code you\'d like to execute.',
        questionsNeeded: { pythonCode: true }
      };
    }

    // Validate Python code has transform function
    if (!skillParams.pythonCode.includes('def transform(')) {
      return {
        action: 'ask_questions',
        followUpQuestion: 'The Python code must include a `transform(data)` function. Please provide valid Python code.',
        questionsNeeded: { pythonCode: true }
      };
    }

    // Ready to execute
    return {
      action: 'generate_transformation',
      skillParams: {
        ...skillParams,
        operationType // Pass operationType to execution
      }
    };
  },

  /**
   * Format the execution result to match transformation output format
   * @param {Object} result - Raw execution result
   * @param {String} operationType - 'sql' or 'nosql'
   * @returns {Object} - Formatted result matching applyTransformationResult format
   */
  formatTransformationResult: (result, operationType = 'sql') => {
    if (!result.success) {
      return {
        success: false,
        message: result.error || 'Python execution failed',
        error: result.error
      };
    }

    return {
      success: true,
      message: `Python transformation completed successfully. Processed ${result.recordCount} records.`,
      data: result.data,
      recordCount: result.recordCount,
      operationType: operationType,
      executionDetails: {
        skillId: 'python-executor',
        skillName: 'Python Executor',
        stdout: result.stdout,
        executionTime: result.executionTime
      }
    };
  },

  /**
   * Execute Python transformation
   * @param {Object} params - Execution parameters
   * @param {Object} params.sourceConnection - Source connection info
   * @param {Object} params.sourceTableSchema - Source table schema
   * @param {String} params.pythonCode - Python code to execute
   * @param {String} params.pythonPath - Optional custom Python path
   * @param {String} params.operationType - 'sql' or 'nosql'
   * @param {Object} params.pluginManager - Plugin manager instance
   * @param {Function} params.getFullConfig - Function to get full config with credentials
   * @returns {Promise<Object>} - Result with transformed data
   */
  execute: async (params) => {
    const {
      sourceConnection,
      sourceTableSchema,
      pythonCode,
      pythonPath = null,
      operationType = 'sql',
      pluginManager,
      getFullConfig,
      appSqliteDbPath,
      helpers,
      targetLocalPath = null,
      // The table the BUILDER named for this node. The workflow executor sends
      // it as `targetTable`; TransformerNodeChat's ad-hoc runs do not, and fall
      // back to the node-id name below.
      targetTable = null
    } = params;
    const startTime = Date.now();

    try {
      // Checked before the source is loaded, so a missing Python fails fast.
      const python = pythonPath ? [pythonPath] : await findPython();
      if (!python) {
        return {
          success: false,
          error: 'Python steps need Python 3 installed on this computer. Install it, then run this step again:\n  '
            + (INSTALL_PYTHON[process.platform] || INSTALL_PYTHON.linux),
          executionTime: Date.now() - startTime
        };
      }

      console.log('[Python Executor] Step 1: Loading source data...');

      // Step 1: Pull data from source (similar to executeOutput)
      let sourceData = [];
      const isLocalFile = sourceConnection.localPath;

      if (isLocalFile) {
        // Local file - load directly
        if (sourceConnection.dbType === 'duckdb') {
          // Every local file is a DuckDB source now — csv, json, parquet, avro,
          // a workbook, or an upstream node's table in the workflow database.
          // Without this branch a local source fell through to no branch at all
          // and the Python ran against ZERO rows, reporting success.
          const localPath = sourceConnection.localPath;
          const recorded = sourceTableSchema.originalTableName || sourceTableSchema.tableName;
          // A workflow database addresses its table by name; a workbook by its
          // sheet — public/lib/duckdb.js registers one view per sheet. Any
          // other file is registered under its own basename.
          const addressedByName = /\.(duckdb|xlsx|xlsm)$/i.test(localPath);
          const tableName = addressedByName
            ? recorded
            : path.basename(localPath, path.extname(localPath));
          if (!tableName) throw new Error('No table recorded for the local source');
          sourceData = await helpers.runQuery(
            'duckdb', { query: `SELECT * FROM "${tableName}"` }, localPath,
          );
          console.log(`[Python Executor] Loaded ${sourceData.length} rows from ${tableName}`);
        } else if (sourceConnection.dbType === 'sqlite') {
          // Read through the app's SQLite helper (DuckDB's sqlite extension),
          // the same route the JavaScript executor takes.
          const tableName = sourceTableSchema.originalTableName || sourceTableSchema.tableName;
          sourceData = await helpers.runQuery(
            'sqlite', { query: `SELECT * FROM "${String(tableName).replace(/"/g, '""')}"` }, sourceConnection.localPath,
          );
          console.log(`[Python Executor] Loaded ${sourceData.length} rows from local SQLite`);
        }
      } else {
        // Remote connection - use plugin system
        const plugin = pluginManager.getConnector(sourceConnection.dbType);

        if (!plugin) {
          throw new Error(`Plugin not found for database type: ${sourceConnection.dbType}`);
        }

        // Use the quoted tableName for SQL (already includes schema if needed)
        // Use originalTableName for NoSQL collections (no schema needed)
        const isNoSQLDb = sourceConnection.dbType === 'mongodb';
        const tableNameForQuery = isNoSQLDb
          ? (sourceTableSchema.originalTableName || sourceTableSchema.tableName)
          : sourceTableSchema.tableName;

        const sqlQuery = `SELECT * FROM ${sourceTableSchema.tableName}`; // Already quoted with schema

        const queryObj = {
          // For SQL databases
          query: sqlQuery,
          tableName: tableNameForQuery,
          schema: sourceTableSchema.schema || sourceConnection.dbConfig?.schema,

          // For MongoDB
          collection: tableNameForQuery,
          filter: {},

          // For Google Sheets
          spreadsheetId: tableNameForQuery,
          sheetName: sourceTableSchema.sheetName,
          range: null,

          // Common. No limit — the script receives the whole source; a
          // million-row cap here silently shortened what it computed over.
        };

        const fullConfig = await getFullConfig(sourceConnection.id, sourceConnection.dbConfig || {});
        const result = await plugin.runQuery(fullConfig, sourceConnection.id, queryObj);
        sourceData = result.rows || [];

        console.log(`[Python Executor] Loaded ${sourceData.length} rows from remote connection`);
      }

      if (!sourceData || sourceData.length === 0) {
        return {
          success: false,
          error: 'No data loaded from source. Cannot execute transformation on empty dataset.',
          executionTime: Date.now() - startTime
        };
      }

      console.log('[Python Executor] Step 2: Executing Python transformation...');

      // Step 2: Execute Python transformation on loaded data
      const data = sourceData;

      // Create temporary directory for execution
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ternlux-python-'));
      const scriptPath = path.join(tempDir, 'transform_script.py');
      const inputPath = path.join(tempDir, 'input.json');
      const outputPath = path.join(tempDir, 'output.json');

      // Prepare input data
      const inputData = Array.isArray(data) ? data : [data];

      // Create the complete Python script
      const fullScript = `
import json
import sys
import math

# User's transformation code
${pythonCode}

# Helper function to clean NaN/Infinity values for JSON serialization
def clean_for_json(obj):
    """Recursively replace NaN and Infinity with None for valid JSON"""
    if isinstance(obj, list):
        return [clean_for_json(item) for item in obj]
    elif isinstance(obj, dict):
        return {key: clean_for_json(value) for key, value in obj.items()}
    elif isinstance(obj, float):
        if math.isnan(obj) or math.isinf(obj):
            return None
        return obj
    else:
        return obj

# Main execution
if __name__ == '__main__':
    try:
        # Read input data
        with open('${inputPath.replace(/\\/g, '\\\\')}', 'r', encoding='utf-8') as f:
            input_data = json.load(f)

        # Execute transformation
        result = transform(input_data)

        # Clean NaN/Infinity values before JSON serialization
        cleaned_result = clean_for_json(result)

        # Write output
        with open('${outputPath.replace(/\\/g, '\\\\')}', 'w', encoding='utf-8') as f:
            json.dump(cleaned_result, f, ensure_ascii=False, indent=2)

        print("Transformation completed successfully")
        sys.exit(0)
    except Exception as e:
        print(f"Error: {str(e)}", file=sys.stderr)
        sys.exit(1)
`;

      // Write files
      await fs.writeFile(scriptPath, fullScript, 'utf-8');
      await fs.writeFile(inputPath, JSON.stringify(inputData, null, 2), 'utf-8');

      // Execute Python script
      const result = await new Promise((resolve, reject) => {
        let stdout = '';
        let stderr = '';

        const pythonProcess = spawn(python[0], [...python.slice(1), scriptPath], {
          cwd: tempDir,
          env: process.env
        });

        pythonProcess.stdout.on('data', (data) => {
          stdout += data.toString();
        });

        pythonProcess.stderr.on('data', (data) => {
          stderr += data.toString();
        });

        pythonProcess.on('close', async (code) => {
          if (code !== 0) {
            // The script imports at top level, outside its try, so a missing
            // package surfaces as a traceback; name the fix instead.
            const missing = stderr.match(/No module named '([^'.]+)/);
            if (missing) {
              const pkg = PIP_NAMES[missing[1]] || missing[1];
              reject(new Error(`Python is missing the "${pkg}" package. Install it, then run this step again:\n  `
                + shellCommand([...python, '-m', 'pip', 'install', pkg])));
              return;
            }
            reject(new Error(`Python execution failed: ${stderr || 'Unknown error'}`));
            return;
          }

          try {
            // Read output
            const outputData = await fs.readFile(outputPath, 'utf-8');
            const parsedOutput = JSON.parse(outputData);

            // Cleanup
            await fs.rm(tempDir, { recursive: true, force: true });

            resolve({
              success: true,
              data: parsedOutput,
              stdout: stdout,
              recordCount: Array.isArray(parsedOutput) ? parsedOutput.length : 1,
              executionTime: Date.now() - startTime
            });
          } catch (err) {
            reject(new Error(`Failed to read output: ${err.message}`));
          }
        });

        pythonProcess.on('error', (err) => {
          reject(new Error(`Failed to start Python: ${err.message}`));
        });

        // Timeout after 5 minutes
        setTimeout(() => {
          pythonProcess.kill();
          reject(new Error('Python execution timed out after 5 minutes'));
        }, 5 * 60 * 1000);
      });

      console.log('[Python Executor] Step 3: Saving transformed data...');

      // Step 3: Save transformed data to local file
      const { data: transformedData, recordCount, executionTime } = result;
      // A node's output is a table in its workflow's own DuckDB database,
      // whatever shape the transform had. It used to land in a local file under
      // the process's working directory, or in the app-wide SQLite — neither of
      // which any current reader looks in, and the first of which is not even
      // writable in a packaged app.
      const targetDbType = 'duckdb';

      // Where the result is written.
      //
      // The name the BUILDER chose wins. It is what the node records as
      // `targetTableName`, what its preview SQL selects from, and what every
      // downstream node reads — so deriving a different one here (from the node
      // id) wrote the rows to a table nothing else knew about. The run reported
      // success and the output then failed to read with "Table … does not
      // exist", because it genuinely did not.
      //
      // The node-id name stays as the fallback for an ad-hoc run from the node
      // chat, where no target has been settled yet.
      const nodeId = params.nodeId || `transform_${Date.now()}`;
      const targetTableName = (typeof targetTable === 'string' && targetTable.trim())
        ? targetTable.trim()
        : nodeId.replace(/-/g, '_').toLowerCase();

      // The workflow builder records targetLocalPath as the workflow's own
      // database (workflow-data/<workflowId>.duckdb), so the result becomes a
      // table there like every other node's output. An ad-hoc run with no path
      // falls back to a standalone file beside it.
      const localPath = targetLocalPath
        || path.join(require('electron').app.getPath('userData'), 'workflow-data', `${targetTableName}.parquet`);

      const docs = Array.isArray(transformedData) ? transformedData : [transformedData];
      await helpers.runQuery(
        'duckdb',
        { operation: 'insert', mode: 'replace', tableName: targetTableName, docs },
        localPath,
      );
      console.log(`[Python Executor] Saved ${docs.length} row(s) to ${targetTableName} in ${localPath}`);

      const targetPreviewSql = `SELECT * FROM ${targetTableName} LIMIT 100`;

      // Build config object for TransformerNodeChat to save
      const sourceConfig = params.sourceNodeConfig || {};

      console.log('[Python Executor] Step 4: Building config...');

      const config = {
        nodeType: 'transformer',
        sourceNodeId: params.sourceNodeId,
        sourceNodeLabel: params.sourceNodeLabel,
        sourceConnectionId: sourceConnection.id,
        sourceConnectionName: params.sourceConnectionName,
        sourceConnectionType: sourceConnection.connectionType || params.sourceConnectionType,
        sourceDbType: sourceConnection.dbType,
        sourceDbConfig: sourceConnection.dbConfig,
        sourceType: sourceConnection.dbType,
        sourceLocalPath: sourceConnection.localPath,
        sourceTableName: sourceTableSchema.originalTableName || sourceTableSchema.tableName,
        sourceCollection: sourceConfig.targetCollection || sourceConfig.sourceCollection,
        sourceSchema: sourceTableSchema.schema,
        sourceTableSchema: sourceTableSchema,
        storagelocation: 'local',
        // Target configuration (local storage)
        targetConnectionId: `local-${targetDbType}`,
        targetConnectionName: 'Local DuckDB',
        targetConnectionType: 'file',
        targetDbType: targetDbType,
        targetDbConfig: {},
        targetLocalPath: localPath,
        // The result is a table whichever shape the transform had — a document
        // store's collection is no longer a separate destination here.
        targetTableName: targetTableName,
        targetCollection: undefined,
        targetSchema: null,
        targetPreviewSql: targetPreviewSql,

        // Skill execution metadata
        skillExecution: {
          skillId: 'python-executor',
          executionTime: executionTime,
          recordCount: recordCount
        },
        transformationRequest: params.userRequest || 'Python-based transformation',

        // Indicator for frontend to load target table schema
        needsSchemaLoad: true
      };

      return {
        success: true,
        data: transformedData,
        recordCount: recordCount,
        localPath: localPath,
        targetTableName: targetTableName,
        message: `Transformed ${recordCount} records using Python`,
        executionDetails: {
          executionTime: executionTime
        },
        config: config
      };

    } catch (error) {
      console.error('[Python Executor] Error during data loading or transformation:', error);
      return {
        success: false,
        error: error.message,
        executionTime: Date.now() - startTime
      };
    }
  },

  /**
   * Test if Python is available
   */
  testEnvironment: async (pythonPath = 'python3') => {
    try {
      const result = await new Promise((resolve, reject) => {
        const pythonProcess = spawn(pythonPath, ['--version']);

        let version = '';
        pythonProcess.stdout.on('data', (data) => {
          version += data.toString();
        });

        pythonProcess.stderr.on('data', (data) => {
          version += data.toString();
        });

        pythonProcess.on('close', (code) => {
          if (code === 0) {
            resolve({ success: true, version: version.trim() });
          } else {
            reject(new Error('Python not found'));
          }
        });

        pythonProcess.on('error', (err) => {
          reject(err);
        });

        setTimeout(() => {
          pythonProcess.kill();
          reject(new Error('Timeout checking Python version'));
        }, 5000);
      });

      return result;
    } catch (error) {
      return {
        success: false,
        message: error.message
      };
    }
  },

  /**
   * Get available Python libraries
   */
  getAvailableLibraries: async (pythonPath = 'python3') => {
    try {
      const libraries = await new Promise((resolve, reject) => {
        const pythonProcess = spawn(pythonPath, ['-m', 'pip', 'list', '--format=json']);

        let output = '';
        pythonProcess.stdout.on('data', (data) => {
          output += data.toString();
        });

        pythonProcess.on('close', (code) => {
          if (code === 0) {
            try {
              const libs = JSON.parse(output);
              resolve(libs);
            } catch (err) {
              resolve([]);
            }
          } else {
            resolve([]);
          }
        });

        pythonProcess.on('error', () => {
          resolve([]);
        });

        setTimeout(() => {
          pythonProcess.kill();
          resolve([]);
        }, 10000);
      });

      return {
        success: true,
        libraries
      };
    } catch (error) {
      return {
        success: false,
        libraries: []
      };
    }
  },

  /**
   * Check if required Python packages are installed
   */
  checkDependencies: async (pythonPath = 'python3') => {
    try {
      // Create a small Python script to check for packages
      const checkScript = `
import sys
import json

packages = {
    'pandas': False,
    'numpy': False,
    'scipy': False,
    'sklearn': False
}

for package in packages.keys():
    try:
        __import__(package if package != 'sklearn' else 'sklearn')
        packages[package] = True
    except ImportError:
        pass

print(json.dumps(packages))
`;

      const result = await new Promise((resolve, reject) => {
        let output = '';
        const pythonProcess = spawn(pythonPath, ['-c', checkScript]);

        pythonProcess.stdout.on('data', (data) => {
          output += data.toString();
        });

        pythonProcess.on('close', (code) => {
          if (code === 0) {
            try {
              const packages = JSON.parse(output.trim());
              resolve({
                success: true,
                packages,
                allInstalled: Object.values(packages).every(v => v)
              });
            } catch (err) {
              reject(new Error('Failed to parse package check output'));
            }
          } else {
            reject(new Error('Package check failed'));
          }
        });

        pythonProcess.on('error', (err) => {
          reject(err);
        });

        setTimeout(() => {
          pythonProcess.kill();
          reject(new Error('Package check timed out'));
        }, 5000);
      });

      return result;
    } catch (error) {
      return {
        success: false,
        message: error.message,
        packages: {},
        allInstalled: false
      };
    }
  },

  /**
   * Plugin metadata
   */
  metadata: {
    displayName: 'Python Executor',
    description: 'Execute Python code for complex data transformations',
    version: '1.0.0',
    author: 'Ternlux',
    requires: ['python3'],
    recommendedLibraries: ['pandas', 'numpy', 'scipy', 'scikit-learn'],
    setupInstructions: 'Run setup.sh (Unix/macOS) or setup.bat (Windows) to install Python dependencies',
    documentationUrl: 'https://docs.python.org/3/'
  }
};
