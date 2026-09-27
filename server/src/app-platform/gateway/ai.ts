import { z } from 'zod';
import { getActiveAiRuntimeConfig, requestOpenAiMessage } from '../../core/integrations/ai/index.js';
import { GatewayError, type AppGatewayOperation } from './model.js';

const input = z.object({
  system: z.string().trim().min(1).max(3000),
  prompt: z.string().trim().min(1).max(12000)
}).strict();
const output = z.object({ content: z.string().min(1).max(12000) }).strict();

/** One bounded text completion. The platform owns credentials and endpoint policy. */
export function createAiCompletionOperation(dependencies: {
  config?: typeof getActiveAiRuntimeConfig;
  request?: typeof requestOpenAiMessage;
} = {}): AppGatewayOperation {
  const config = dependencies.config ?? getActiveAiRuntimeConfig;
  const request = dependencies.request ?? requestOpenAiMessage;
  return {
    name: 'platform.ai.complete', permissionCode: 'platform.ai.complete', mode: 'read',
    validateParams: value => input.safeParse(value).success,
    resolveResources: async () => [{}],
    async execute(_context, value, signal) {
      const parsed = input.parse(value);
      let runtime;
      try { runtime = (await config()).external; }
      catch { throw new GatewayError('AI_NOT_CONFIGURED', 503); }
      try {
        const message = await request(
          { ...runtime, timeoutMs: Math.min(runtime.timeoutMs, 25_000) },
          [{ role: 'system', content: parsed.system }, { role: 'user', content: parsed.prompt }],
          [], fetch, { signal }
        );
        if (!message.content || message.content.length > 12000) throw new GatewayError('INVALID_RESULT', 502);
        return { content: message.content };
      } catch (error) {
        if (error instanceof GatewayError) throw error;
        throw new GatewayError(signal.aborted ? 'ABORTED' : 'AI_UNAVAILABLE', signal.aborted ? 499 : 502);
      }
    },
    validateResult: value => output.safeParse(value).success
  };
}
