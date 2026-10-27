/**
 * Renderer-side helper for the chatPrompts:build IPC channel.
 *
 * The actual prompt-builder functions live in public/ChatPrompts/ and are
 * loaded by the electron main process — see electron.js / preload.js. We
 * call them by "moduleName.methodName" plus an argument array and get back
 * the rendered prompt string.
 */
export async function buildChatPrompt(key, args = []) {
  if (!window.electronAPI?.chatPrompts?.build) {
    throw new Error('chatPrompts IPC is not available in this environment');
  }
  const result = await window.electronAPI.chatPrompts.build(key, args);
  if (!result?.success) {
    throw new Error(result?.message || `Failed to build chat prompt: ${key}`);
  }
  return result.prompt;
}
