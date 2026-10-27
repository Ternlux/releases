/**
 * Utility functions for vector database operations
 */

const crypto = require('crypto');

/**
 * Generate a unique ID for a vector record
 * @param {String} prefix - Optional prefix
 * @returns {String} Unique ID
 */
function generateId(prefix = 'vec') {
  const timestamp = Date.now();
  const random = crypto.randomBytes(8).toString('hex');
  return `${prefix}_${timestamp}_${random}`;
}

/**
 * Validate vector dimension compatibility
 * @param {Number} expected - Expected dimension
 * @param {Number} actual - Actual dimension
 * @throws {Error} If dimensions don't match
 */
function validateDimension(expected, actual) {
  if (expected !== actual) {
    throw new Error(
      `Dimension mismatch: Expected ${expected} but got ${actual}. ` +
      `Ensure embedding model matches vector database dimension.`
    );
  }
}

/**
 * Prepare vector records for upserting
 * Adds IDs if missing and formats metadata
 * @param {Array} data - Array of records with vectors
 * @param {String} columnToEmbed - Original column that was embedded
 * @returns {Array} Prepared records
 */
function prepareVectorRecords(data, columnToEmbed) {
  return data.map(record => {
    // Ensure record has an ID
    if (!record.id) {
      record.id = generateId();
    }

    // Ensure vector field exists
    if (!record.vector || !Array.isArray(record.vector)) {
      throw new Error(`Missing or invalid vector in record: ${JSON.stringify(record)}`);
    }

    // Prepare metadata (all fields except vector and _* fields)
    const metadata = {};
    for (const key in record) {
      if (key !== 'vector' && !key.startsWith('_')) {
        metadata[key] = record[key];
      }
    }

    // Store original text that was embedded
    if (columnToEmbed && record[columnToEmbed]) {
      metadata._original_text = record[columnToEmbed];
    }

    return {
      id: record.id,
      vector: record.vector,
      metadata: metadata
    };
  });
}

/**
 * Format vector database results for display
 * @param {Array} results - Results from vector DB query
 * @param {Boolean} includeVectors - Whether to include vector values
 * @returns {Array} Formatted results
 */
function formatVectorResults(results, includeVectors = false) {
  return results.map(result => {
    const formatted = {
      id: result.id,
      score: result.score || result._distance,
      ...result.metadata
    };

    if (includeVectors && result.vector) {
      formatted.vector = result.vector;
    }

    return formatted;
  });
}

/**
 * Chunk array into smaller batches
 * @param {Array} array - Array to chunk
 * @param {Number} size - Chunk size
 * @returns {Array<Array>} Array of chunks
 */
function chunkArray(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

/**
 * Calculate progress percentage
 * @param {Number} current - Current count
 * @param {Number} total - Total count
 * @returns {Number} Percentage (0-100)
 */
function calculateProgress(current, total) {
  if (total === 0) return 100;
  return Math.min(100, Math.round((current / total) * 100));
}

/**
 * Format bytes to human-readable string
 * @param {Number} bytes - Bytes
 * @returns {String} Formatted string
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';

  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

/**
 * Sanitize table name for database use
 * @param {String} name - Original name
 * @returns {String} Sanitized name
 */
function sanitizeTableName(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Parse filter expression for vector databases
 * @param {String} filter - Filter expression
 * @returns {Object} Parsed filter object
 */
function parseFilter(filter) {
  if (!filter) return {};

  try {
    // If it's already JSON, parse it
    if (filter.trim().startsWith('{')) {
      return JSON.parse(filter);
    }

    // Otherwise, treat it as a simple expression
    // e.g., "category = 'tech'" or "id = '123'"
    return { _raw: filter };
  } catch (error) {
    console.warn(`Failed to parse filter: ${filter}`, error);
    return {};
  }
}

module.exports = {
  generateId,
  validateDimension,
  prepareVectorRecords,
  formatVectorResults,
  chunkArray,
  calculateProgress,
  formatBytes,
  sanitizeTableName,
  parseFilter
};
