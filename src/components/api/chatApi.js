import { asyncJobClient } from '../../utils/asyncJobClient';

/**
 * Estimates a rough token count for a text string (4 chars ≈ 1 token).
 * @param {string} text
 * @returns {number}
 */
function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

/**
 * Trims message history to fit within a character-based token limit and
 * formats each message into the { role, content } shape expected by the LLM.
 *
 * Metadata fields (goal, stepDescription) are appended to the message text
 * so the LLM has full context about multi-step analyses.
 *
 * @param {Array<{text: string, sender: string, metadata?: Object}>} messages
 * @param {number} maxTokens - Max character-estimate (default 25 000)
 * @returns {Array<{role: string, content: string}>}
 */
export function buildChatChain(messages, maxTokens = 25000) {
  let totalTokens = 0;
  const trimmed = [];

  for (let i = messages.length - 1; i >= 0; i--) {
    const tokens = estimateTokens(messages[i].text);
    if (totalTokens + tokens <= maxTokens) {
      trimmed.unshift(messages[i]);
      totalTokens += tokens;
    } else {
      break;
    }
  }

  return trimmed.map(msg => {
    let text = msg.text;

    if (msg?.metadata?.plan?.goal) {
      text += ` Goal: ${msg.metadata.plan.goal}`;
    }
    if (msg?.metadata?.stepDescription) {
      text += ` Multi-step - Steps Description: ${msg.metadata.stepDescription}`;
    }

    return {
      role: msg.sender === 'user' ? 'user' : 'assistant',
      content: text,
    };
  });
}

/**
 * Sends a user message to the LLM for workflow analysis.
 *
 * Starts an async job on the backend and polls until completion.
 *
 * @param {string} input - User's natural language input
 * @param {Array<{role: string, content: string}>} chatChain - Formatted history from buildChatChain()
 * @param {string|null} chatId - Current chat session ID
 * @param {Function|null} onProgress - Called with { progress, stage, status } during polling
 * @returns {Promise<Object>} Raw API result (check result.success)
 */
export async function workflowAnalysis(input, chatChain = [], chatId = null, onProgress = null) {
  return asyncJobClient.startJob(
    '/chat/workflow-analysis-async',
    {
      input,
      chat_chain: chatChain,
      chat_id: chatId,
    },
    { onProgress }
  );
}

/**
 * Maps a raw workflowAnalysis API response into UI-ready state objects.
 *
 * Handles three scenarios:
 *   1. Single-turn response — no multi-step data
 *   2. Multi-step analysis that is still executing — returns executing multiStepData
 *   3. Multi-step analysis that completed inline — returns completed multiStepData
 *
 * @param {Object} response - Raw result from workflowAnalysis()
 * @param {string} currentChatTitle - The chat title currently shown in the UI
 * @returns {{
 *   botResponse: Object,
 *   multiStepData: Object|null,
 *   isExecuting: boolean
 * }}
 */
export function parseWorkflowAnalysisResponse(response, currentChatTitle) {
  const botResponse = {
    id: Date.now() + 1,
    text: response.response,
    sender: 'bot',
    timestamp: new Date(),
    metadata: response.analysis_metadata,
    visualizationData: response.visualizationData,
    explanation: response.explanation,
    multiStep: response.multiStep,
    goal: response.goal,
    stepResults: response.stepResults,
    totalSteps: response.totalSteps,
    completedSteps: response.completedSteps,
  };

  let multiStepData = null;
  let isExecuting = false;

  if (response.multiStep && response.executionStarted && response.chatId) {
    isExecuting = true;
    multiStepData = {
      reportId: response.reportId,
      title: response.chatTitle || currentChatTitle,
      goal: response.goal,
      steps: response.steps,
      totalSteps: response.totalSteps,
      chatId: response.chatId,
      status: 'executing',
    };
  } else if (response.multiStep && response.stepResults) {
    multiStepData = {
      reportId: response.reportId,
      title: response.chatTitle || currentChatTitle,
      goal: response.goal,
      stepResults: response.stepResults,
      totalSteps: response.totalSteps,
      completedSteps: response.completedSteps,
    };
  }

  return { botResponse, multiStepData, isExecuting };
}
