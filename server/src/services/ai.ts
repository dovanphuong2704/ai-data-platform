import { ChatOpenAI } from '@langchain/openai';
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { BaseMessage, HumanMessage, SystemMessage, AIMessage } from '@langchain/core/messages';
import { AIServiceConfig } from '../types';

// ─── Model Config ─────────────────────────────────────────────────────────

export interface ChatModelConfig {
  temperature?: number;
  maxTokens?: number;
  modelName?: string;
  streaming?: boolean;
  /** Gemini only: thinking budget in tokens (0 = no thinking, 1024+ = deep reasoning) */
  thinkingBudget?: number;
}

const DEFAULT_TEMPERATURE = 0;
const DEFAULT_MAX_TOKENS = 4096;

/**
 * Fetch real available models from provider API.
 */
export async function fetchProviderModels(provider: string, apiKey: string): Promise<string[]> {
  const key = apiKey.trim();
  if (!key) throw new Error('API key is empty');

  switch (provider) {
    case 'openai': {
      const { default: OpenAI } = await import('openai');
      const client = new OpenAI({ apiKey: key });
      const response = await client.models.list();
      const models: string[] = [];
      for await (const m of response) { models.push(m.id); }
      return models.filter(id => id.startsWith('gpt-')).sort();
    }

    case 'grok': {
      const { default: OpenAI } = await import('openai');
      const client = new OpenAI({ apiKey: key, baseURL: 'https://api.x.ai/v1' });
      const response = await client.models.list();
      const models: string[] = [];
      for await (const m of response) { models.push(m.id); }
      return models.sort();
    }

    case 'gemini': {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`,
        { signal: controller.signal }
      );
      clearTimeout(timeout);
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Gemini API error ${res.status}: ${text}`);
      }
      const json = await res.json() as { models: Array<{ name: string; supportedGenerationMethods: string[] }> };
      return json.models
        .map(m => m.name.replace('models/', ''))
        .filter(name => name.startsWith('gemini-'))
        .filter(name => !name.includes('deep-research'))
        .filter(name => !name.includes('native-audio'))
        .filter(name => !name.includes('live'))
        .filter(name => !name.includes('image'))
        .filter(name => !name.includes('tts'))
        .filter(name => !name.includes('computer-use'))
        .filter(name => !name.includes('robotics'))
        .sort();
    }

    case 'claude': {
      // Anthropic list models endpoint
      const res = await fetch('https://api.anthropic.com/v1/models', {
        headers: {
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        },
      });
      if (!res.ok) throw new Error(`Claude API error: ${res.status}`);
      const json = await res.json() as { data: Array<{ id: string }> };
      return json.data.map(m => m.id).sort();
    }

    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

/**
 * Returns model config. modelOverride is required — client must pass selected model.
 */
export function getChatModelConfig(
  provider: string,
  _apiKey: string,
  modelOverride?: string,
): ChatModelConfig {
  if (!modelOverride) {
    throw new Error(`No model specified for provider "${provider}". Please select a model from the dropdown.`);
  }
  return { modelName: modelOverride, temperature: DEFAULT_TEMPERATURE, maxTokens: DEFAULT_MAX_TOKENS };
}

// ─── Model Factory ─────────────────────────────────────────────────────────

type LCChatModel = ChatOpenAI | ChatAnthropic | ChatGoogleGenerativeAI;

/**
 * Creates a LangChain chat model instance based on the provider.
 * Supports: openai, grok (via OpenAI-compatible endpoint), gemini, claude.
 */
export function createChatModel(
  provider: string,
  apiKey: string,
  config: ChatModelConfig
): LCChatModel {
  const { temperature = DEFAULT_TEMPERATURE, maxTokens = DEFAULT_MAX_TOKENS, modelName } = config;

  switch (provider) {
    case 'openai': {
      return new ChatOpenAI({
        apiKey,
        model: modelName ?? 'gpt-4o',
        temperature,
        maxTokens,
        streaming: config.streaming ?? false,
      });
    }

    case 'grok': {
      // Grok uses an OpenAI-compatible endpoint
      return new ChatOpenAI({
        apiKey,
        model: modelName ?? 'grok-2',
        temperature,
        maxTokens,
        streaming: config.streaming ?? false,
        configuration: {
          baseURL: 'https://api.x.ai/v1',
        },
      });
    }

    case 'gemini': {
      return new ChatGoogleGenerativeAI({
        apiKey,
        model: modelName ?? 'gemini-2.5-flash',
        temperature,
        maxOutputTokens: maxTokens,
        streaming: config.streaming ?? false,
        ...(config.thinkingBudget !== undefined && {
          thinkingConfig: {
            thinkingBudget: config.thinkingBudget,
            thinkingLevel: 'MEDIUM',
          },
        }),
      });
    }

    case 'claude': {
      return new ChatAnthropic({
        apiKey,
        model: modelName ?? 'claude-sonnet-4-20250514',
        temperature,
        maxTokens,
        streaming: config.streaming ?? false,
      });
    }

    default: {
      // Default to OpenAI for unknown providers
      return new ChatOpenAI({
        apiKey,
        model: modelName ?? 'gpt-4o',
        temperature,
        maxTokens,
        streaming: config.streaming ?? false,
      });
    }
  }
}

// ─── Chat Helper ────────────────────────────────────────────────────────────

export interface ChatInput {
  provider: string;
  apiKey: string;
  systemMessage?: string;
  messages: Array<{ role: string; content: string }>;
  temperature?: number;
  maxTokens?: number;
}

export interface ChatOutput {
  content: string;
  finishReason: string;
}

/**
 * Convenience wrapper: send a list of messages to a provider and get a string response.
 */
export async function chatWithModel(input: ChatInput): Promise<ChatOutput> {
  const config = getChatModelConfig(input.provider, input.apiKey);
  const mergedConfig: ChatModelConfig = {
    ...config,
    ...(input.temperature !== undefined && { temperature: input.temperature }),
    ...(input.maxTokens !== undefined && { maxTokens: input.maxTokens }),
  };

  const model = createChatModel(input.provider, input.apiKey, mergedConfig);

  const langChainMessages: BaseMessage[] = [];

  if (input.systemMessage) {
    langChainMessages.push(new SystemMessage({ content: input.systemMessage }));
  }

  for (const msg of input.messages) {
    if (msg.role === 'user') {
      langChainMessages.push(new HumanMessage({ content: msg.content }));
    } else if (msg.role === 'assistant') {
      langChainMessages.push(new AIMessage({ content: msg.content }));
    } else if (msg.role === 'system') {
      langChainMessages.push(new SystemMessage({ content: msg.content }));
    }
  }

  const response = await model.invoke(langChainMessages);

  const content = typeof response === 'string' ? response : response.content;

  let finishReason = 'stop';
  if (
    response &&
    typeof response === 'object' &&
    'additional_kwargs' in response
  ) {
    const ak = response.additional_kwargs as Record<string, unknown>;
    if (ak.finish_reason) {
      finishReason = String(ak.finish_reason);
    }
  }

  return {
    content: content as string,
    finishReason,
  };
}

// ─── Streaming Helper (optional, for future use) ───────────────────────────

export interface StreamOptions {
  provider: string;
  apiKey: string;
  messages: Array<{ role: string; content: string }>;
  systemMessage?: string;
  temperature?: number;
  maxTokens?: number;
}

/**
 * Returns an async generator for streaming responses.
 * Usage: for await (const chunk of streamChat(opts)) { ... }
 */
export async function* streamChat(opts: StreamOptions): AsyncGenerator<string> {
  const config = getChatModelConfig(opts.provider, opts.apiKey);
  const mergedConfig: ChatModelConfig = {
    ...config,
    ...(opts.temperature !== undefined && { temperature: opts.temperature }),
    ...(opts.maxTokens !== undefined && { maxTokens: opts.maxTokens }),
    streaming: true,
  };

  const model = createChatModel(opts.provider, opts.apiKey, mergedConfig);

  const langChainMessages: BaseMessage[] = [];

  if (opts.systemMessage) {
    langChainMessages.push(new SystemMessage({ content: opts.systemMessage }));
  }

  for (const msg of opts.messages) {
    langChainMessages.push(new HumanMessage({ content: msg.content }));
  }

  const stream = await model.stream(langChainMessages);

  for await (const chunk of stream) {
    const text = typeof chunk === 'string' ? chunk : (chunk as { content?: string }).content;
    if (text) yield text as string;
  }
}
