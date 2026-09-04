const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const os = require('os');

const SYSTEM_PROMPT = `You are an Autonomous Universal CI/CD Self-Healing AI Engine.
Analyze the CI error log and project context below.
Diagnose the root cause of the failure and synthesize a surgical repair.

UNIVERSAL GUIDANCE:
- PRESERVE LOGIC INTENT: Never delete user variable assignments, function calls, or execution statements unless they are syntactically invalid. Keep all business logic and reassignment lines intact.
- SURGICAL DECLARATION FIXES: When repairing immutability or reassignment errors (e.g. constant reassignment), change only the binding/declaration keyword (e.g. const -> let) on the initial declaration line. Preserve all subsequent variable reads and writes intact.
- SURGICAL LINE EDITS: Always prefer precise "lineEdits" over full file replacements to avoid dropping surrounding code, comments, or structure.
- TOKEN & TREE BALANCE: For unclosed tags, brackets, parens, or strings, balance opening and closing tokens in their exact syntactic hierarchy position without dropping sibling or parent nodes.
- ZERO ERRORS: Ensure the resulting patch produces clean code with ZERO compiler, lint, or test failures.

Return ONLY raw JSON matching this exact schema:
{
  "action": "INSTALL_DEPENDENCY" | "REFACTOR_CODE" | "SYNC_ENV_KEY" | "FIX_CONFIG",
  "target": "relative/file/path/or/package_name",
  "lineEdits": [{ "startLine": number, "endLine": number, "replacement": "string" }],
  "replacementCode": "Complete repaired source code for the target file",
  "envKey": "Key name if action is SYNC_ENV_KEY, otherwise null",
  "explanation": "Brief description of the diagnosis and fix"
}`;

function resolveApiKey(argKey, cwd) {
  if (argKey && !argKey.startsWith('$') && argKey !== 'undefined' && argKey !== 'null' && !argKey.startsWith('AQ.')) {
    return argKey;
  }
  if (argKey && argKey.startsWith('$')) {
    const envVal = process.env[argKey.slice(1)];
    if (envVal && !envVal.startsWith('AQ.')) return envVal;
  }
  const envCandidates = [process.env.OPENAI_API_KEY, process.env.GEMINI_API_KEY, process.env.LLM_API_KEY, process.env.api_key];
  for (const k of envCandidates) {
    if (k && !k.startsWith('AQ.')) return k;
  }

  const keyFiles = [
    path.join(os.homedir(), '.rote', 'keys.json'),
    path.join(os.homedir(), '.rote', 'config', 'keys.json'),
    path.join(os.homedir(), '.env'),
    path.join(cwd, '.env'),
    path.join(cwd, '.env.local')
  ];

  for (const kf of keyFiles) {
    try {
      if (fs.existsSync(kf)) {
        const content = fs.readFileSync(kf, 'utf8');
        if (kf.endsWith('.json')) {
          const parsed = JSON.parse(content);
          if (parsed.OPENAI_API_KEY && !parsed.OPENAI_API_KEY.startsWith('AQ.')) return parsed.OPENAI_API_KEY;
          if (parsed.GEMINI_API_KEY && !parsed.GEMINI_API_KEY.startsWith('AQ.')) return parsed.GEMINI_API_KEY;
          if (parsed.api_key && !parsed.api_key.startsWith('AQ.')) return parsed.api_key;
        } else {
          const match = content.match(/(?:OPENAI_API_KEY|GEMINI_API_KEY|LLM_API_KEY|API_KEY)=([^\s"']+)/i);
          if (match && match[1] && !match[1].startsWith('AQ.')) return match[1];
        }
      }
    } catch {}
  }
  return null;
}

function normalizeDiagnosisSchema(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  if (Array.isArray(parsed.actions) && parsed.actions.length > 0) {
    const act = parsed.actions[0];
    return {
      action: act.action || act.type || 'REFACTOR_CODE',
      target: act.target || act.filePath || act.file || parsed.target,
      lineEdits: (act.lineEdits || act.edits || []).map(e => ({
        startLine: Number(e.startLine),
        endLine: Number(e.endLine),
        replacement: e.replacement
      })),
      replacementCode: act.replacementCode || act.code || parsed.replacementCode || null,
      envKey: act.envKey || parsed.envKey || null,
      explanation: parsed.explanation || act.explanation || 'Self-healing patch synthesized'
    };
  }
  return parsed;
}

function parseLlmJson(rawText) {
  if (!rawText) return null;
  let cleaned = rawText.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
  let parsed = null;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        parsed = JSON.parse(jsonMatch[0]);
      } catch {
        try {
          const sanitized = jsonMatch[0].replace(/,\s*([\}\]])/g, '$1');
          parsed = JSON.parse(sanitized);
        } catch { parsed = null; }
      }
    }
  }
  return normalizeDiagnosisSchema(parsed);
}

function callGeminiApiSingle(apiKey, model, logText, context) {
  return new Promise((resolve) => {
    if (!apiKey) return resolve({ error: 'NO_API_KEY: Gemini API Key missing.' });
    if (apiKey.startsWith('AQ')) return resolve({ error: 'INVALID_KEY: Rote platform access token detected.' });

    const targetModel = model || 'gemini-1.5-flash';
    const options = {
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/${targetModel}:generateContent?key=${apiKey}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    };
    const userPrompt = `${SYSTEM_PROMPT}\n\nCI Error Log:\n${logText.slice(0, 4000)}\n\nProject Context:\n${context.slice(0, 9000)}`;
    const payload = JSON.stringify({ contents: [{ parts: [{ text: userPrompt }] }] });

    const req = https.request(options, (res) => {
      if (res.statusCode !== 200) {
        let errBody = '';
        res.on('data', c => errBody += c);
        res.on('end', () => {
          let msg = `HTTP ${res.statusCode}`;
          try {
            const parsed = JSON.parse(errBody);
            if (parsed.error?.message) msg = `API Error (HTTP ${res.statusCode}): ${parsed.error.message.slice(0, 120)}`;
          } catch {}
          resolve({ error: msg });
        });
        return;
      }
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          const parts = parsed.candidates?.[0]?.content?.parts || [];
          const fullText = parts.map(p => p.text || '').join('\n');
          const resJson = parseLlmJson(fullText);
          if (resJson) return resolve(resJson);
          for (const p of parts) {
            if (p.text) {
              const r = parseLlmJson(p.text);
              if (r) return resolve(r);
            }
          }
          resolve(null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(45000, () => { req.destroy(); resolve(null); });
    req.write(payload);
    req.end();
  });
}

async function callGeminiApi(apiKey, model, logText, context) {
  if (!apiKey) return { error: 'NO_API_KEY: Gemini API Key missing.' };
  if (apiKey.startsWith('AQ')) return { error: 'INVALID_KEY: Rote token detected.' };

  const primaryModel = model || 'gemini-1.5-flash';
  const fallbackCandidates = [primaryModel, 'gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-2.0-flash-exp'].filter((m, idx, self) => m && self.indexOf(m) === idx);

  let lastResult = null;
  for (const targetModel of fallbackCandidates) {
    const result = await callGeminiApiSingle(apiKey, targetModel, logText, context);
    if (result && !result.error) return result;
    lastResult = result;
    if (result?.error && (result.error.includes('NO_API_KEY') || result.error.includes('INVALID_KEY'))) return result;
  }
  return lastResult;
}

function callOpenAiApi(apiKey, model, logText, context, customBaseUrl) {
  return new Promise((resolve) => {
    let hostname = 'api.openai.com';
    let pathName = '/v1/chat/completions';
    let isHttps = true;
    let port = 443;

    if (customBaseUrl) {
      try {
        const parsedUrl = new URL(customBaseUrl);
        hostname = parsedUrl.hostname;
        pathName = parsedUrl.pathname.endsWith('/chat/completions') ? parsedUrl.pathname : (parsedUrl.pathname.endsWith('/') ? parsedUrl.pathname + 'chat/completions' : parsedUrl.pathname + '/chat/completions');
        isHttps = parsedUrl.protocol === 'https:';
        port = parsedUrl.port ? parseInt(parsedUrl.port, 10) : (isHttps ? 443 : 80);
      } catch {}
    }

    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const options = { hostname, port, path: pathName, method: 'POST', headers };
    const userContent = `CI Error Log:\n${logText.slice(0, 4000)}\n\nProject Context:\n${context.slice(0, 9000)}`;
    const payload = JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent }
      ],
      temperature: 0.1
    });

    const httpModule = isHttps ? https : http;
    const req = httpModule.request(options, (res) => {
      if (res.statusCode !== 200) return resolve(null);
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          const text = parsed.choices?.[0]?.message?.content || '';
          resolve(parseLlmJson(text));
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(12000, () => { req.destroy(); resolve(null); });
    req.write(payload);
    req.end();
  });
}

module.exports = {
  SYSTEM_PROMPT,
  resolveApiKey,
  parseLlmJson,
  callGeminiApi,
  callOpenAiApi
};
