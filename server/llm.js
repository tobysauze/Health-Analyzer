function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function getLlmConfig() {
  const provider = String(process.env.LLM_PROVIDER || 'openai').toLowerCase(); // openai | openrouter
  if (provider === 'openrouter') {
    return {
      provider,
      apiKey: process.env.OPENROUTER_API_KEY || '',
      baseUrl: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
      defaultModel: process.env.OPENROUTER_MODEL || process.env.LLM_MODEL || 'openai/gpt-4o-mini',
      headers: {
        // Optional but recommended by OpenRouter
        ...(process.env.OPENROUTER_SITE_URL ? { 'HTTP-Referer': process.env.OPENROUTER_SITE_URL } : {}),
        ...(process.env.OPENROUTER_APP_NAME ? { 'X-Title': process.env.OPENROUTER_APP_NAME } : {})
      }
    };
  }
  return {
    provider: 'openai',
    apiKey: process.env.OPENAI_API_KEY || '',
    baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    defaultModel: process.env.OPENAI_MODEL || process.env.LLM_MODEL || 'gpt-4o-mini',
    headers: {}
  };
}

function normalizeInt(val, min, max) {
  if (val === null || val === undefined || val === '') return null;
  const n = Number(val);
  if (!Number.isFinite(n)) return null;
  const r = Math.round(n);
  return Math.min(max, Math.max(min, r));
}

function normalizeFloat(val) {
  if (val === null || val === undefined || val === '') return null;
  if (typeof val === 'number') return Number.isFinite(val) ? val : null;
  const s = String(val).trim();
  if (!s) return null;
  // Extract first number, tolerate commas/units e.g. "31.4g", "0,65 g", "673kJ/159kcal"
  const m = s.replace(',', '.').match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

function normalizeFoodPackaging(parsed) {
  try {
    const n = parsed?.nutrition;
    if (!n) return parsed;
    const buckets = ['per_100g', 'per_serving'];
    const fields = ['calories_kcal', 'protein_g', 'carbs_g', 'sugar_g', 'fat_g', 'sat_fat_g', 'fiber_g', 'salt_g'];
    for (const b of buckets) {
      if (!n[b] || typeof n[b] !== 'object') continue;
      for (const f of fields) {
        n[b][f] = normalizeFloat(n[b][f]);
      }
    }
  } catch {}
  return parsed;
}

async function extractJournalSignalsLLM({ text, model = 'gpt-4o-mini' }) {
  const cfg = getLlmConfig();
  const apiKey = cfg.apiKey;
  if (!apiKey) return { ok: false, error: `${cfg.provider.toUpperCase()} API key not set` };
  const useModel = model || cfg.defaultModel;

  // Minimal, structured extraction. This is not medical advice.
  const schemaHint = {
    emotions: [{ label: 'anger|sadness|anxiety|joy|calm|stress|frustration|fear|guilt|shame|neutral|other', intensity_1_10: 7 }],
    events: [{ category: 'work|family|relationships|health|finance|exercise|sleep|food|other', description: '...', valence: 'negative|positive|neutral' }],
    symptoms: [{ name: 'nausea|headache|bloating|rash|fatigue|other', severity_1_10: 4, suspected_trigger: '...' }],
    tags: ['work', 'sleep'],
    inferred: { mood_score_1_10: 5, stress_score_1_10: 6, energy_score_1_10: 4, anxiety_score_1_10: 6 },
    confidence_0_1: 0.62,
    summary: '1-2 sentence summary.'
  };

  const body = {
    model: useModel,
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: [
          'You extract structured signals from a personal journal entry for a health tracking app.',
          'Return ONLY valid JSON.',
          'Do not give medical advice. Prefer cautious hypotheses.',
          'If unsure, lower confidence and keep fields empty/null.'
        ].join(' ')
      },
      {
        role: 'user',
        content: [
          'Journal entry:',
          text,
          '',
          'Return JSON matching this shape (values can be empty):',
          JSON.stringify(schemaHint)
        ].join('\n')
      }
    ]
  };

  const resp = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      ...cfg.headers
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    return { ok: false, error: `LLM error ${resp.status}: ${t.slice(0, 400)}` };
  }

  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content;
  let parsed = typeof content === 'string' ? safeJsonParse(content) : null;
  if (!parsed && typeof content === 'string') {
    // Some providers may wrap JSON in text; try to salvage by extracting first {...} block.
    const m = content.match(/\{[\s\S]*\}/);
    if (m) parsed = safeJsonParse(m[0]);
  }
  if (!parsed) return { ok: false, error: 'LLM returned non-JSON' };

  // Normalize inferred scores
  if (parsed.inferred && typeof parsed.inferred === 'object') {
    parsed.inferred.mood_score_1_10 = normalizeInt(parsed.inferred.mood_score_1_10, 1, 10);
    parsed.inferred.stress_score_1_10 = normalizeInt(parsed.inferred.stress_score_1_10, 1, 10);
    parsed.inferred.energy_score_1_10 = normalizeInt(parsed.inferred.energy_score_1_10, 1, 10);
    parsed.inferred.anxiety_score_1_10 = normalizeInt(parsed.inferred.anxiety_score_1_10, 1, 10);
  }

  const confidence = Number(parsed.confidence_0_1);
  parsed.confidence_0_1 = Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.4;

  return { ok: true, extracted: parsed };
}

async function analyzeFoodPackagingLLM({ imageDataUrls = [], hints = '', model = 'gpt-4o-mini' }) {
  const cfg = getLlmConfig();
  const apiKey = cfg.apiKey;
  if (!apiKey) return { ok: false, error: `${cfg.provider.toUpperCase()} API key not set` };
  const useModel = model || cfg.defaultModel;

  const schemaHint = {
    product_name: 'string|null',
    brand: 'string|null',
    serving_size: 'string|null',
    ingredients: 'string|null',
    allergens: 'string|null',
    nutrition: {
      per_100g: {
        calories_kcal: 'number|null',
        protein_g: 'number|null',
        carbs_g: 'number|null',
        sugar_g: 'number|null',
        fat_g: 'number|null',
        sat_fat_g: 'number|null',
        fiber_g: 'number|null',
        salt_g: 'number|null'
      },
      per_serving: {
        calories_kcal: 'number|null',
        protein_g: 'number|null',
        carbs_g: 'number|null',
        sugar_g: 'number|null',
        fat_g: 'number|null',
        sat_fat_g: 'number|null',
        fiber_g: 'number|null',
        salt_g: 'number|null'
      }
    },
    confidence_0_1: 0.6,
    notes: 'short text'
  };

  const content = [];
  content.push({
    type: 'text',
    text: [
      'Extract food packaging information from the images (or screenshots of product pages).',
      'Focus on UK-style nutrition tables + ingredient lists.',
      '',
      'Important:',
      '- Nutrition tables may be shown as "Typical values per 100g" (sometimes without per-serving). If only per-100g exists, fill ONLY nutrition.per_100g.',
      '- Parse rows for: Energy (kcal), Fat, Saturates, Carbohydrate, Sugars, Fibre, Protein, Salt.',
      '- If a row says "Energy kJ/kcal", use the kcal number.',
      '- Return numbers as numbers (grams as g). If label uses mg, convert to grams.',
      '- If you can read a value, do NOT leave it null.',
      'Return ONLY valid JSON.',
      'If you cannot read something, use null and lower confidence.',
      '',
      'Hints from user:',
      String(hints || ''),
      '',
      'Return JSON matching this shape:',
      JSON.stringify(schemaHint)
    ].join('\n')
  });

  for (const url of imageDataUrls.slice(0, 6)) {
    if (!url) continue;
    content.push({ type: 'image_url', image_url: { url } });
  }

  const body = {
    model: useModel,
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: [
          'You extract structured nutrition + ingredients from food packaging images.',
          'Return ONLY valid JSON. No medical advice.'
        ].join(' ')
      },
      { role: 'user', content }
    ]
  };

  const resp = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      ...cfg.headers
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    return { ok: false, error: `LLM error ${resp.status}: ${t.slice(0, 400)}` };
  }

  const data = await resp.json();
  const contentOut = data?.choices?.[0]?.message?.content;
  let parsed = typeof contentOut === 'string' ? safeJsonParse(contentOut) : null;
  if (!parsed && typeof contentOut === 'string') {
    const m = contentOut.match(/\{[\s\S]*\}/);
    if (m) parsed = safeJsonParse(m[0]);
  }
  if (!parsed) return { ok: false, error: 'LLM returned non-JSON' };

  const conf = Number(parsed.confidence_0_1);
  parsed.confidence_0_1 = Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0.4;
  parsed = normalizeFoodPackaging(parsed);
  return { ok: true, extracted: parsed };
}

async function estimateFoodFromTextLLM({ text, model = 'gpt-4o-mini' }) {
  const cfg = getLlmConfig();
  const apiKey = cfg.apiKey;
  if (!apiKey) return { ok: false, error: `${cfg.provider.toUpperCase()} API key not set` };
  const useModel = model || cfg.defaultModel;

  const schemaHint = {
    food_name: 'string',
    quantity_text: 'string|null',
    estimated: { calories_kcal: 'number|null', protein_g: 'number|null', carbs_g: 'number|null', fat_g: 'number|null' },
    per_100g: { calories_kcal: 'number|null', protein_g: 'number|null', carbs_g: 'number|null', fat_g: 'number|null' },
    confidence_0_1: 0.6,
    notes: 'short text'
  };

  const body = {
    model: useModel,
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: [
          'You estimate calories and macronutrients for a food item given its name and quantity.',
          'Use common nutrition databases heuristically (UK/US generic values).',
          'Return ONLY valid JSON, and be explicit about uncertainty.',
          'If quantity is missing, assume a reasonable single serving and set quantity_text accordingly.'
        ].join(' ')
      },
      {
        role: 'user',
        content: [
          'Estimate calories/macros for this food:',
          text,
          '',
          'Rules:',
          '- Output calories_kcal, protein_g, carbs_g, fat_g for the given quantity.',
          '- Also include per_100g if you can infer it (optional).',
          '- Return numbers only (no units in numeric fields).',
          '',
          'Return JSON matching this shape:',
          JSON.stringify(schemaHint)
        ].join('\n')
      }
    ]
  };

  const resp = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      ...cfg.headers
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    return { ok: false, error: `LLM error ${resp.status}: ${t.slice(0, 400)}` };
  }
  const data = await resp.json();
  const contentOut = data?.choices?.[0]?.message?.content;
  let parsed = typeof contentOut === 'string' ? safeJsonParse(contentOut) : null;
  if (!parsed && typeof contentOut === 'string') {
    const m = contentOut.match(/\{[\s\S]*\}/);
    if (m) parsed = safeJsonParse(m[0]);
  }
  if (!parsed) return { ok: false, error: 'LLM returned non-JSON' };

  const conf = Number(parsed.confidence_0_1);
  parsed.confidence_0_1 = Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0.4;

  // normalize numbers (re-use normalizeFloat already in this file)
  try {
    const fields = ['calories_kcal', 'protein_g', 'carbs_g', 'fat_g'];
    if (parsed.estimated) for (const f of fields) parsed.estimated[f] = normalizeFloat(parsed.estimated[f]);
    if (parsed.per_100g) for (const f of fields) parsed.per_100g[f] = normalizeFloat(parsed.per_100g[f]);
  } catch {}

  return { ok: true, extracted: parsed };
}

module.exports = {
  extractJournalSignalsLLM,
  analyzeFoodPackagingLLM,
  estimateFoodFromTextLLM,
  async generateMarkdownLLM({ prompt, model = 'gpt-4o-mini' }) {
    const cfg = getLlmConfig();
    const apiKey = cfg.apiKey;
    if (!apiKey) return { ok: false, error: `${cfg.provider.toUpperCase()} API key not set` };
    const useModel = model || cfg.defaultModel;
    const body = {
      model: useModel,
      temperature: 0.4,
      messages: [
        {
          role: 'system',
          content: [
            'You write concise, helpful health tracking summaries.',
            'Be cautious: hypotheses only; no medical advice.',
            'Do not diagnose. Keep it actionable and neutral.',
            'Output Markdown only.'
          ].join(' ')
        },
        { role: 'user', content: String(prompt || '') }
      ]
    };

    const resp = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        ...cfg.headers
      },
      body: JSON.stringify(body)
    });

    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      return { ok: false, error: `LLM error ${resp.status}: ${t.slice(0, 400)}` };
    }
    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) return { ok: false, error: 'Empty LLM response' };
    return { ok: true, markdown: String(content) };
  }
};

