// Automatic extraction: send the syllabus straight to Claude and get structured
// assignments back. Needs an Anthropic API key (kept only in this browser's
// localStorage). This is the "drop it in and it reads it" path.
//
// The manual copy/paste bridge (bridge.js) stays as the no-key fallback and
// shares the prompt + response parser with this module.

import Anthropic from '@anthropic-ai/sdk';
import { buildClaudePrompt, parseClaudeItems, estCostCents } from './bridge.js';

export { estCostCents };

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(new Error('could not read the file'));
    r.readAsDataURL(file);
  });
}

// { apiKey, model, text?, file? } + { courseId, courseName, termLabel, termStartKey }
export async function aiExtract(opts, ctx = {}) {
  const { apiKey, model = 'claude-opus-5', text = '', file = null } = opts;
  if (!apiKey) throw new Error('no API key set');

  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });

  const content = [];
  let usedFile = false;
  if (file) {
    const name = (file.name || '').toLowerCase();
    const isPdf = file.type === 'application/pdf' || name.endsWith('.pdf');
    const b64 = await fileToBase64(file);
    if (isPdf) {
      content.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: b64 },
      });
      usedFile = true;
    } else if (file.type.startsWith('image/')) {
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: IMAGE_TYPES.includes(file.type) ? file.type : 'image/png',
          data: b64,
        },
      });
      usedFile = true;
    }
  }

  // If we sent the file itself, don't also stuff the rough OCR text in — the
  // model reads the original far better. Otherwise send the text.
  const promptText = buildClaudePrompt(usedFile ? '' : text, { termLabel: ctx.termLabel });
  content.push({ type: 'text', text: promptText });

  let resp;
  try {
    resp = await client.messages.create({
      model,
      max_tokens: 8000,
      messages: [{ role: 'user', content }],
    });
  } catch (err) {
    throw friendlyError(err);
  }

  if (resp.stop_reason === 'refusal') {
    throw new Error('Claude declined to process this document. Try the manual steps below.');
  }

  const out = resp.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

  const items = parseClaudeItems(out, {
    courseId: ctx.courseId,
    courseName: ctx.courseName,
    termStartKey: ctx.termStartKey,
  });
  return { items, usage: resp.usage, model: resp.model };
}

// (estCostCents lives in bridge.js so the Settings/bridge views can show cost
//  without pulling in the Anthropic SDK.)

function friendlyError(err) {
  if (err instanceof Anthropic.AuthenticationError) {
    return new Error('That API key was rejected. Check it in Settings (it should start with "sk-ant-").');
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return new Error('This API key isn’t allowed to use that model. Pick a different model in Settings.');
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new Error('Anthropic rate-limited the request. Wait a minute and try again.');
  }
  if (err instanceof Anthropic.BadRequestError) {
    return new Error(`Claude rejected the request: ${err.message}`);
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new Error('Couldn’t reach Anthropic — check your internet connection.');
  }
  if (err instanceof Anthropic.APIError) {
    return new Error(`Anthropic API error ${err.status ?? ''}: ${err.message}`);
  }
  return err instanceof Error ? err : new Error(String(err));
}
