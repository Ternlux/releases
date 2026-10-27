/**
 * Embedding generation library for vector database operations
 * OpenAI is the only embedding provider
 */

const { OpenAI } = require('openai');
const { throwIfCancelled } = require('../NodeExecution/executionCancel');

/**
 * Generate embeddings for an array of data rows
 * @param {Object} params - Parameters
 * @param {Array} params.data - Array of data rows
 * @param {String} params.columnToEmbed - Column name to extract text from
 * @param {String} params.provider - 'openai'
 * @param {String} params.model - Model name/ID
 * @param {String} params.apiKey - API key for the provider
 * @returns {Promise<Array>} Array of data rows with added 'vector' field
 */
async function generateEmbeddings({ data, columnToEmbed, provider, model, apiKey }) {
  console.log('generateEmbeddings: ', { data, columnToEmbed, provider, model })
  if (!data || data.length === 0) {
    throw new Error('No data provided for embedding generation');
  }

  if (!columnToEmbed) {
    throw new Error('columnToEmbed is required');
  }

  if (!provider) {
    throw new Error('Embedding provider is required (openai)');
  }

  if (!apiKey) {
    throw new Error('API key is required for embedding generation');
  }

  // Resolve a column that may be a flat key ("channel") or a dotted path into a
  // nested object ("properties.channel"). Prefer an exact own-key match so a
  // literal key containing a dot still works, then fall back to path traversal.
  const getByPath = (obj, pathStr) => {
    if (obj == null) return undefined;
    if (Object.prototype.hasOwnProperty.call(obj, pathStr)) return obj[pathStr];
    return pathStr.split('.').reduce(
      (acc, key) => (acc == null ? undefined : acc[key]),
      obj
    );
  };

  // Extract and validate texts from specified column
  const validRows = [];
  const texts = [];

  for (const row of data) {
    const raw = getByPath(row, columnToEmbed);
    // Accept strings directly; coerce other non-null primitives (numbers,
    // booleans) to string. Skip null/undefined, objects/arrays, and empties.
    let text = null;
    if (typeof raw === 'string') {
      text = raw;
    } else if (raw != null && typeof raw !== 'object') {
      text = String(raw);
    }
    if (text != null && text.trim().length > 0) {
      validRows.push(row);
      texts.push(text.trim());
    }
  }

  if (texts.length === 0) {
    throw new Error(`No valid text found in column: ${columnToEmbed}`);
  }

  console.log(`Generating embeddings for ${texts.length} texts using ${provider} (${model})...`);

  let embeddings;

  if (provider === 'openai') {
    embeddings = await generateOpenAIEmbeddings(texts, model, apiKey);
  } else {
    throw new Error(`Unknown embedding provider: ${provider}. Supported: openai`);
  }

  // Validate embeddings
  if (!embeddings || embeddings.length !== texts.length) {
    throw new Error('Embedding generation failed: received invalid embeddings');
  }

  // Merge embeddings back with original data
  const result = validRows.map((row, idx) => ({
    ...row,
    vector: embeddings[idx],
    _embedded_column: columnToEmbed,
    _embedding_provider: provider,
    _embedding_model: model,
    _embedded_at: new Date().toISOString()
  }));

  console.log(`Successfully generated ${result.length} embeddings (dimension: ${embeddings[0]?.length || 'unknown'})`);

  return result;
}

/**
 * Generate OpenAI embeddings
 * @param {Array<String>} texts - Array of texts to embed
 * @param {String} model - OpenAI model name
 * @param {String} apiKey - OpenAI API key
 * @returns {Promise<Array<Array<Number>>>} Array of embedding vectors
 */
async function generateOpenAIEmbeddings(texts, model = 'text-embedding-3-small', apiKey) {
  const openai = new OpenAI({ apiKey });

  // OpenAI supports batching up to 2048 inputs per request
  const BATCH_SIZE = 100;
  const allEmbeddings = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    // Embedding a large source is one HTTP round-trip per 100 texts — a
    // 100k-row upsert is a thousand of them, all inside a single node, and by
    // far the longest thing a vector write does. Every batch is also billed, so
    // stopping here stops the spend as well as the wait.
    throwIfCancelled('generating embeddings', `${allEmbeddings.length} of ${texts.length} embedded`);

    const batch = texts.slice(i, i + BATCH_SIZE);

    console.log(`Processing OpenAI batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(texts.length / BATCH_SIZE)}...`);

    try {
      const response = await openai.embeddings.create({
        model,
        input: batch,
        encoding_format: 'float'
      });

      const batchEmbeddings = response.data.map(item => item.embedding);
      allEmbeddings.push(...batchEmbeddings);
    } catch (error) {
      throw new Error(`OpenAI embedding generation failed: ${error.message}`);
    }
  }

  return allEmbeddings;
}

/**
 * Estimate embedding cost for OpenAI
 * @param {Array<String>} texts - Texts to estimate cost for
 * @param {String} model - OpenAI model name
 * @returns {Object} { tokens, estimatedCost }
 */
function estimateOpenAICost(texts, model = 'text-embedding-3-small') {
  // Rough estimation: ~1 token per 4 characters
  const estimatedTokens = texts.reduce((sum, text) =>
    sum + Math.ceil(text.length / 4), 0
  );

  // Pricing as of 2024 (per 1M tokens)
  const pricing = {
    'text-embedding-3-small': 0.00002,  // $0.02 per 1M tokens
    'text-embedding-3-large': 0.00013,  // $0.13 per 1M tokens
    'text-embedding-ada-002': 0.0001   // $0.10 per 1M tokens
  };

  const pricePerToken = pricing[model] || pricing['text-embedding-3-small'];
  const estimatedCost = estimatedTokens * pricePerToken;

  return {
    tokens: estimatedTokens,
    estimatedCost: estimatedCost
  };
}

/**
 * Get embedding dimension for a model
 * @param {String} provider - 'openai'
 * @param {String} model - Model name
 * @returns {Number|null} Dimension or null if unknown
 */
function getEmbeddingDimension(provider, model) {
  if (provider === 'openai') {
    const dimensions = {
      'text-embedding-3-small': 1536,
      'text-embedding-3-large': 3072,
      'text-embedding-ada-002': 1536
    };
    return dimensions[model] || null;
  }

  return null;
}

module.exports = {
  generateEmbeddings,
  generateOpenAIEmbeddings,
  estimateOpenAICost,
  getEmbeddingDimension
};
