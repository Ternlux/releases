import axios from 'axios';

/**
 * Utility class for handling async job polling
 */
class AsyncJobClient {
  constructor(baseURL = '', defaultTimeout = 300000) { // 5 minutes default timeout
    this.baseURL = baseURL;
    this.defaultTimeout = defaultTimeout;
    this.pollingInterval = 4000; // Poll every 1 second
  }

  /**
   * Start an async job and return a promise that resolves when the job completes
   * @param {string} endpoint - The async endpoint to call
   * @param {Object} data - The data to send to the endpoint
   * @param {Object} options - Additional options (headers, timeout, etc.)
   * @returns {Promise} - Promise that resolves with the job result
   */
  async startJob(endpoint, data, options = {}) {
    const { timeout = this.defaultTimeout, onProgress = null, ...axiosOptions } = options;

    try {
      // Start the async job
      const startResponse = await axios.post(`${this.baseURL}${endpoint}`, data, {
        headers: {
          'Content-Type': 'application/json',
          'auth-token': localStorage.getItem('auth-token'),
          ...axiosOptions.headers
        },
        ...axiosOptions
      });

      if (!startResponse.data.success || !startResponse.data.jobId) {
        throw new Error('Failed to start job: ' + (startResponse.data.error || 'Unknown error'));
      }

      const jobId = startResponse.data.jobId;
      
      // Poll for job completion
      return this.pollJobStatus(jobId, timeout, onProgress);

    } catch (error) {
      console.error('Error starting async job:', error);
      
      // Redirect to login on authentication errors
      if (error.response?.status === 400 || error.response?.status === 401) {
        const currentUrl = encodeURIComponent(window.location.pathname + window.location.search);
        window.location.href = `/login?redirect=${currentUrl}`;
        return;
      }
      
      throw error;
    }
  }

  /**
   * Poll job status until completion or timeout
   * @param {string} jobId - The job ID to poll
   * @param {number} timeout - Timeout in milliseconds
   * @param {Function} onProgress - Callback for progress updates
   * @returns {Promise} - Promise that resolves with the job result
   */
  async pollJobStatus(jobId, timeout, onProgress = null) {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeout) {
      try {
        const statusResponse = await axios.get(`/chat/job-status/${jobId}`, {
          headers: {
            'auth-token': localStorage.getItem('auth-token')
          }
        });

        if (statusResponse.data.success) {
          const job = statusResponse.data.job;

          // Call progress callback if provided
          if (onProgress && typeof onProgress === 'function') {
            onProgress({
              progress: job.progress || 0,
              stage: job.stage || 'Processing',
              status: job.status,
              error: job.error || null,
              details: job.details || null
            });
          }

          if (job.status === 'completed') {
            return job.result;
          } else if (job.status === 'failed') {
            const errorDetails = {
              message: job.error || 'Job failed with unknown error',
              details: job.details || null,
              stage: job.stage || 'Unknown stage',
              progress: job.progress || 0,
              jobId: jobId,
              timestamp: new Date().toISOString()
            };
            
            const error = new Error(errorDetails.message);
            error.jobDetails = errorDetails;
            throw error;
          }
        } else if (statusResponse.status === 404) {
          throw new Error('Job not found');
        } else if (statusResponse.status === 410) {
          throw new Error('Job expired');
        }

      } catch (error) {
        if (error.response?.status === 400 || error.response?.status === 401) {
          // Redirect to login on authentication errors
          const currentUrl = encodeURIComponent(window.location.pathname + window.location.search);
          window.location.href = `/login?redirect=${currentUrl}`;
          return;
        } else if (error.response?.status === 404) {
          throw new Error('Job not found');
        } else if (error.response?.status === 410) {
          throw new Error('Job expired');
        }
        console.warn('Error polling job status, retrying...', error.message);
      }

      // Wait before next poll
      await new Promise(resolve => setTimeout(resolve, this.pollingInterval));
    }

    throw new Error('Job timed out after ' + (timeout / 1000) + ' seconds');
  }

  /**
   * Convenience methods for specific endpoints
   */
  
  async joinNodesAnalysis(description, connectedNodes, joinId, nodeName = null, options = {}) {
    return this.startJob('/chat/join-nodes-async', {
      description,
      connectedNodes,
      joinId,
      node_name: nodeName
    }, options);
  }

  async workflowAnalysis(input, chatChain = [], options = {}) {
    const { chatId, ...jobOptions } = options;
    
    return this.startJob('/chat/workflow-analysis-async', {
      input,
      chat_chain: chatChain,
      chat_id: chatId
    }, jobOptions);
  }

  async generateFilteredQuery(workflow, sql, options = {}) {
    return this.startJob('/chat/generate-filtered-query-async', {
      workflow,
      sql
    }, options);
  }

  async transformationAnalysis(description, connectedNode, transformId = null, enrichmentType = null, radiusMiles = null, nodeName = null, options = {}) {
    return this.startJob('/chat/transformation-async', {
      description,
      connectedNode,
      transformId,
      enrichmentType,
      radiusMiles,
      node_name: nodeName
    }, options);
  }

}

// Export a singleton instance
export const asyncJobClient = new AsyncJobClient();
export default AsyncJobClient;