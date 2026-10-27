import { asyncJobClient } from '../../utils/asyncJobClient';

/**
 * Sends a transformation request to the LLM for analysis and execution.
 *
 * Supports two modes:
 *   - Enrichment (menu_items, locations_top_visitors, demographic_breakdown,
 *     location_enrichment) — uses enrichmentType + radiusMiles
 *   - Regular transformation — natural-language SQL transformation
 *
 * @param {string} description - User's transformation request text
 * @param {Object} connectedNode - Source node info { nodeId, dataset, connectionId, table }
 * @param {string|null} transformId - Transformer node ID
 * @param {string|null} enrichmentType - Enrichment subtype or null
 * @param {number|null} radiusMiles - Search radius for location enrichment, or null
 * @param {string|null} nodeName - Optional display name for the node
 * @param {Function|null} onProgress - Called with { progress, stage, status } during polling
 * @returns {Promise<Object>} Raw API result (check result.success)
 */
export async function transformationAnalysis(
  description,
  connectedNode,
  transformId = null,
  enrichmentType = null,
  radiusMiles = null,
  nodeName = null,
  onProgress = null
) {
  return asyncJobClient.transformationAnalysis(
    description,
    connectedNode,
    transformId,
    enrichmentType,
    radiusMiles,
    nodeName,
    { onProgress }
  );
}

/**
 * Maps a raw transformationAnalysis API response into a plan object and
 * the config values to auto-save on the transformer node.
 *
 * Returns { isEnrichment: true } for enrichment results and
 * { isEnrichment: false } for regular SQL transformations.
 *
 * @param {Object} response - Raw result from transformationAnalysis()
 * @param {Object} nodeConfig - Current node config (node.data.config)
 * @param {string} transformationType - The transformation/enrichment type selected in the UI
 * @param {number|null} radiusMiles - Radius used for location enrichment
 * @param {string} transformationRequest - The user's raw text request
 * @returns {{
 *   plan: Object,
 *   autoSaveValues: Object,
 *   isEnrichment: boolean
 * }}
 */
export function parseTransformationResponse(
  response,
  nodeConfig,
  transformationType,
  radiusMiles,
  transformationRequest
) {
  const isEnrichmentType =
    transformationType === 'menu_items' ||
    transformationType === 'locations_top_visitors' ||
    transformationType === 'demographic_breakdown' ||
    transformationType === 'location_enrichment';

  if (isEnrichmentType) {
    const plan = {
      enrichmentType: response.enrichmentType,
      enrichmentResult: response.enrichmentResult,
      transformationType: 'enrichment',
    };

    const autoSaveValues = {
      ...nodeConfig,
      connectionName: response.enrichmentResult.connectionName,
      connectionId: response.enrichmentResult.connectionId,
      transformationPlan: plan,
      transformationType: transformationType,
      radiusMiles: radiusMiles,
      transformationRequest: transformationRequest || `${transformationType} enrichment`,
    };

    return { plan, autoSaveValues, isEnrichment: true };
  }

  const analysis = response.transformationAnalysis;
  const plan = {
    transformationType: analysis?.transformationType || 'custom',
    description: analysis?.description || transformationRequest,
    sql: analysis?.sql,
    summary: analysis?.description || 'Custom transformation applied',
  };

  const autoSaveValues = {
    ...nodeConfig,
    connectionName: response.connectionName,
    connectionId: response.connectionId,
    transformationPlan: plan,
    transformationType: nodeConfig?.transformationType || 'custom',
    radiusMiles: radiusMiles,
    transformationRequest: transformationRequest,
    newConnectionId: response.newConnectionId,
  };

  return { plan, autoSaveValues, isEnrichment: false };
}

/**
 * Sends a join description to the LLM to analyse and execute a join across
 * multiple connected data sources.
 *
 * @param {string} description - User's natural language join description
 * @param {Array<Object>} connectedNodes - Node info objects { nodeId, dataset, connectionId, s3Key, schema }
 * @param {string} joinId - Join node ID
 * @param {string|null} nodeName - Optional display name for the node
 * @param {Function|null} onProgress - Called with { progress, stage, status } during polling
 * @returns {Promise<Object>} Raw API result (check result.success)
 */
export async function joinNodesAnalysis(
  description,
  connectedNodes,
  joinId,
  nodeName = null,
  onProgress = null
) {
  return asyncJobClient.joinNodesAnalysis(
    description,
    connectedNodes,
    joinId,
    nodeName,
    { onProgress }
  );
}

/**
 * Maps a raw joinNodesAnalysis API response into the join result and
 * the config values to auto-save on the join node.
 *
 * Handles three error scenarios:
 *   - 'execution'  — join SQL ran but failed
 *   - 'connection' — join ran but connection creation failed
 *   - 'missing'    — success but connectionName/connectionId absent
 *
 * @param {Object} response - Raw result from joinNodesAnalysis()
 * @param {Object} nodeConfig - Current node config (node.data.config)
 * @param {string} joinDescription - The user's join description text
 * @returns {{
 *   joinResult: Object,
 *   autoSaveValues: Object|null,
 *   hasError: boolean,
 *   errorType: 'execution'|'connection'|'missing'|null
 * }}
 */
export function parseJoinResponse(response, nodeConfig, joinDescription) {
  const joinResult = response.joinAnalysis;

  if (response.executionError) {
    joinResult.error = response.executionError.message;
    joinResult.executionFailed = true;
    return { joinResult, autoSaveValues: null, hasError: true, errorType: 'execution' };
  }

  if (response.connectionError) {
    return { joinResult, autoSaveValues: null, hasError: true, errorType: 'connection' };
  }

  if (!response.connectionName || !response.connectionId) {
    return { joinResult, autoSaveValues: null, hasError: true, errorType: 'missing' };
  }

  const autoSaveValues = {
    ...nodeConfig,
    connectionName: response.connectionName,
    connectionId: response.connectionId,
    joinAnalysis: joinResult,
    joinDescription: joinDescription,
  };

  return { joinResult, autoSaveValues, hasError: false, errorType: null };
}
