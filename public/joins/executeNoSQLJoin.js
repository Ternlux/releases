/**
 * Execute NoSQL Join
 * Handles join operations where the destination is a NoSQL database (MongoDB), or
 * a local result, which lands as a table in the workflow's DuckDB database.
 *
 * Process:
 * 1. Load all source data into memory (using nosqlOperation queries)
 * 2. Execute JavaScript join function to combine data
 * 3. Insert joined results into destination NoSQL database
 */

const { getConnection } = require('../database-connectors');

/**
 * Execute a NoSQL join operation
 * @param {Object} params - Join execution parameters
 * @param {Object} params.destinationConnection - Target NoSQL database connection config
 * @param {Array} params.sourcesConfig - Array of source configurations with nosqlOperation
 * @param {string} params.javascriptFunction - JavaScript function to perform the join
 * @param {string} params.targetCollection - Name of the destination collection
 * @param {string} params.operationMode - "new_table" or "merge_existing"
 * @param {boolean} params.isLocalStorage - Whether destination is local storage
 * @param {Function} params.onProgress - Progress callback function
 * @returns {Object} Result with success status and message
 */
async function executeNoSQLJoin({
  destinationConnection,
  sourcesConfig,
  javascriptFunction,
  targetCollection,
  operationMode = 'new_table',
  isLocalStorage = false,
  // Optional — scopes the local result to this workflow/node.
  targetLocalPath = null,
  workflowId = null,
  nodeId = null,
  onProgress = () => {}
}) {
  try {
    onProgress({ stage: 'Loading source data...', progress: 0 });

    // Step 1: Load all source data into memory
    const sourceDataArrays = [];

    for (let i = 0; i < sourcesConfig.length; i++) {
      const sourceConfig = sourcesConfig[i];

      onProgress({
        stage: `Loading data from source ${i + 1} of ${sourcesConfig.length}...`,
        progress: (i / sourcesConfig.length) * 40
      });

      // Get source connection
      const sourceConnection = sourceConfig.connection || sourceConfig.sourceConnection;

      if (!sourceConnection) {
        throw new Error(`Source connection not found for ${sourceConfig.sourceNodeId}`);
      }

      let sourceData = [];

      // Check if source is NoSQL or SQL
      const isNoSQLSource = sourceConnection.dbType === 'mongodb';

      if (isNoSQLSource) {
        // Load from the MongoDB source using nosqlOperation. It is the only
        // document store left: every local file, JSON included, is read as SQL
        // by DuckDB and takes the branch below.
        const sourceConn = await getConnection(
          sourceConnection.dbType,
          sourceConnection.dbConfig || {},
          sourceConnection.id
        );

        // Parse nosqlOperation (should be JSON string)
        const operation = JSON.parse(sourceConfig.nosqlOperation || '{}');

        const collection = sourceConn.db.collection(operation.collection || operation.tableName);
        const filter = operation.filter || {};
        const limit = operation.limit || 0;

        if (limit > 0) {
          sourceData = await collection.find(filter).limit(limit).toArray();
        } else {
          sourceData = await collection.find(filter).toArray();
        }
      } else {
        // Load from SQL source using sql query
        const sourceConn = await getConnection(
          sourceConnection.dbType,
          sourceConnection.dbConfig || {},
          sourceConnection.id
        );

        const result = await sourceConn.executeQuery(sourceConfig.sql);
        sourceData = result.rows || result || [];
      }

      console.log(`Loaded ${sourceData.length} rows from source ${i + 1}`);
      sourceDataArrays.push(sourceData);
    }

    onProgress({ stage: 'Executing join function...', progress: 50 });

    // Step 2: Execute JavaScript join function
    let joinFunction;
    try {
      // Evaluate the JavaScript function
      joinFunction = eval(`(${javascriptFunction})`);
    } catch (evalError) {
      throw new Error(`Failed to parse join function: ${evalError.message}`);
    }

    if (typeof joinFunction !== 'function') {
      throw new Error('Invalid join function: must be a function');
    }

    // Execute the join function with all source data arrays
    const joinedResults = joinFunction(...sourceDataArrays);

    if (!Array.isArray(joinedResults)) {
      throw new Error('Join function must return an array of documents');
    }

    console.log(`Join function produced ${joinedResults.length} results`);

    onProgress({ stage: 'Inserting joined data...', progress: 70 });

    // Step 3: Insert results into destination
    let insertResult;

    if (isLocalStorage) {
      // A join's local result is a table in the workflow's own DuckDB database,
      // the same as every other node output.
      const duck = require('../duckdb');
      const table = targetCollection || `join_${String(nodeId || Date.now()).replace(/[^A-Za-z0-9_]/g, '_')}`;
      const mode = operationMode === 'new_table' ? 'replace' : 'append';

      if (joinedResults.length === 0) {
        insertResult = { success: true, message: 'Join produced no documents', recordCount: 0 };
      } else {
        const { rowCount } = targetLocalPath && !workflowId
          ? await duck.ingestRowsToTableAt(joinedResults, targetLocalPath, table, { mode })
          : await duck.ingestRowsToTable(joinedResults, workflowId, table, { mode });
        insertResult = {
          success: true,
          message: `Saved ${rowCount} document(s) to ${table}`,
          recordCount: rowCount,
          documentsInserted: rowCount,
          localPath: workflowId ? duck.workflowDbPath(workflowId) : targetLocalPath,
          targetTableName: table,
        };
      }
    } else {
      // Insert into remote NoSQL database
      const destConn = await getConnection(
        destinationConnection.dbType,
        destinationConnection.dbConfig || {},
        destinationConnection.id
      );

      if (destinationConnection.dbType === 'mongodb') {
        const collection = destConn.db.collection(targetCollection);

        // For new_table mode, drop existing collection
        if (operationMode === 'new_table') {
          try {
            await collection.drop();
          } catch (dropErr) {
            // Collection might not exist, that's okay
          }
        }

        // Insert documents
        if (joinedResults.length > 0) {
          const insertManyResult = await collection.insertMany(joinedResults);
          insertResult = {
            success: true,
            message: `Successfully inserted ${insertManyResult.insertedCount} documents into ${targetCollection}`,
            documentsInserted: insertManyResult.insertedCount
          };
        } else {
          insertResult = {
            success: true,
            message: 'No documents to insert',
            documentsInserted: 0
          };
        }
      } else {
        throw new Error(`Unsupported NoSQL database type: ${destinationConnection.dbType}`);
      }
    }

    onProgress({ stage: 'Complete', progress: 100 });

    return {
      success: true,
      message: insertResult.message || `Join completed. ${joinedResults.length} documents inserted into ${targetCollection}`,
      documentsInserted: joinedResults.length,
      targetCollection,
      localPath: insertResult.localPath
    };

  } catch (error) {
    return {
      success: false,
      message: `NoSQL join failed: ${error.message}`,
      error: error.stack
    };
  }
}

module.exports = { executeNoSQLJoin };
