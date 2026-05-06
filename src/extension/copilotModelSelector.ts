import * as vscode from 'vscode';

/**
 * Selects the best available VS Code Language Model Chat model.
 *
 * Strategy (in order):
 *  1. If the user pinned a model ID/family via `automatedqa.copilotModel`, try that first.
 *  2. Try any model with no filter — pick the first one returned.
 *  3. If nothing is available, throw a descriptive error that lists what models
 *     VS Code currently knows about (even if 0).
 *
 * This replaces the old hardcoded `selectChatModels({ family: 'gpt-4o' })` calls
 * that silently returned nothing for users with Qwen, Claude, Gemini, or other
 * Copilot-provided model families.
 */
export async function selectBestCopilotModel(): Promise<vscode.LanguageModelChat> {
  const preferredId = vscode.workspace
    .getConfiguration('automatedqa')
    .get<string>('copilotModel', '')
    .trim();

  // 1. Try the user's pinned preference first
  if (preferredId) {
    // Try as family name first, then as exact id
    const byFamily = await vscode.lm.selectChatModels({ family: preferredId });
    if (byFamily.length > 0) { return byFamily[0]; }

    const byId = await vscode.lm.selectChatModels({ id: preferredId });
    if (byId.length > 0) { return byId[0]; }

    // Preference set but not found — warn and fall through
    vscode.window.showWarningMessage(
      `Automated QA: Copilot model "${preferredId}" not found. ` +
      `Falling back to the first available model. ` +
      `Check automatedqa.copilotModel in Settings.`
    );
  }

  // 2. Get everything VS Code has, no filter
  const all = await vscode.lm.selectChatModels({});
  if (all.length > 0) { return all[0]; }

  // 3. Nothing at all — build a useful error
  const names = await listAvailableModelNames();
  const detail = names.length > 0
    ? `Available: ${names.join(', ')}`
    : 'No Language Model Chat models are registered. Is GitHub Copilot installed and signed in?';

  throw new Error(
    `No Copilot LM chat model available. ${detail}\n\n` +
    `You can pin a specific model via Settings → automatedqa.copilotModel (e.g. "gpt-4o", "qwen", "claude-3").`
  );
}

/**
 * Returns display names of all models currently available through the VS Code LM API.
 * Useful for error messages and the connection test.
 */
export async function listAvailableModelNames(): Promise<string[]> {
  try {
    const all = await vscode.lm.selectChatModels({});
    return all.map(m => `${m.name} (${m.id})`);
  } catch {
    return [];
  }
}
