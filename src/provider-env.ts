// Shared provider-to-runtime env normalization.

export function normalizeProviderEnv(provider: string, envVars: Record<string, string>): Record<string, string> {
  const normalized = { ...envVars };

  if (provider === 'openrouter') {
    if (normalized['OPENROUTER_API_KEY'] && !normalized['OPENAI_API_KEY']) {
      normalized['OPENAI_API_KEY'] = normalized['OPENROUTER_API_KEY'];
    }
    if (!normalized['OPENAI_BASE_URL']) {
      normalized['OPENAI_BASE_URL'] = 'https://openrouter.ai/api/v1';
    }
  }

  if (provider === 'zai') {
    if (normalized['ZAI_API_KEY'] && !normalized['OPENAI_API_KEY']) {
      normalized['OPENAI_API_KEY'] = normalized['ZAI_API_KEY'];
    }
    if (!normalized['OPENAI_BASE_URL']) {
      normalized['OPENAI_BASE_URL'] = 'https://api.z.ai/api/coding/paas/v4';
    }
  }

  if (provider === 'minimax') {
    if (normalized['MINIMAX_API_KEY'] && !normalized['ANTHROPIC_API_KEY']) {
      normalized['ANTHROPIC_API_KEY'] = normalized['MINIMAX_API_KEY'];
    }
    if (!normalized['ANTHROPIC_BASE_URL']) {
      normalized['ANTHROPIC_BASE_URL'] = 'https://api.minimax.io/anthropic';
    }
  }

  return normalized;
}

export function serializeEnvFile(envVars: Record<string, string>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(envVars)) {
    lines.push(`${key}=${value}`);
  }
  return lines.join('\n') + (lines.length > 0 ? '\n' : '');
}
