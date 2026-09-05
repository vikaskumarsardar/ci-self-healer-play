const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const os = require('os');

const SYSTEM_PROMPT = `You are an Autonomous Universal CI/CD Self-Healing AI Engine.
Analyze the CI error log and project context below.
Diagnose the root cause of the failure and synthesize a surgical repair.

STRICT PRESERVATION & SURGICAL REPAIR GUIDANCE:
- MANDATORY ACTIONS & LINE EDITS: You MUST supply valid "actions" with precise, non-empty "lineEdits" targeting the failing files based on the line numbers in the provided file context. NEVER return an empty actions array [].
- ESLINT & LINT CONFIG FIXES: If a linter fails due to unknown/missing rule names (e.g. "Could not find rule ..."), add those rules set to 'off' in the project's linter config file under the rules section using lineEdits.
- CONST DECLARATION FIXES: When repairing constant variable reassignment errors (reassigning a "const" variable), change ONLY "const" to "let" on its initial declaration line using lineEdits.
- JSX & HTML TAG BALANCE: For unclosed or mismatched tags, supply lineEdits adding ONLY the missing closing tag. Never delete parent, child, or sibling nodes.
- MULTI-FILE REPAIRS: If multiple files contain lint, build, or test errors, supply a repair action for EVERY failing file in the "actions" array so all issues are healed simultaneously.
- ZERO ERRORS: Ensure the resulting patch produces clean code with ZERO compiler, lint, or test failures.

Return ONLY raw JSON matching this schema:
{
  "actions": [
    {
      "action": "FIX_CONFIG" | "REFACTOR_CODE" | "INSTALL_DEPENDENCY" | "SYNC_ENV_KEY",
      "target": "relative/file/path",
      "lineEdits": [{ "startLine": number, "endLine": number, "replacement": "string" }],
      "explanation": "Brief description of the fix for this file"
    }
  ],
  "explanation": "Brief summary of all repairs"
}`;

function resolveApiKey(argKey, cwd) {
  let key = null;
  if (argKey && !argKey.startsWith('$') && argKey !== 'undefined' && argKey !== 'null') {
    key = argKey;
  }
  if (!key && argKey && argKey.startsWith('$')) {
    const envVal = process.env[argKey.slice(1)];
    if (envVal) key = envVal;
  }
  if (!key) {
    const envCandidates = [process.env.GEMINI_API_KEY, process.env.OPENAI_API_KEY, process.env.LLM_API_KEY, process.env.api_key];
    for (const k of envCandidates) {
      if (k) { key = k; break; }
    }
  }

  if (!key) {
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
            if (parsed.GEMINI_API_KEY) key = parsed.GEMINI_API_KEY;
            else if (parsed.OPENAI_API_KEY) key = parsed.OPENAI_API_KEY;
            else if (parsed.api_key) key = parsed.api_key;
          } else {
            const match = content.match(/(?:GEMINI_API_KEY|OPENAI_API_KEY|LLM_API_KEY|API_KEY)=([^\s"']+)/i);
            if (match && match[1]) key = match[1];
          }
          if (key) break;
        }
      } catch {}
    }
  }
  return key ? key.replace(/['"\r\n\t]/g, '').trim() : null;
}

function normalizeDiagnosisSchema(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  
  let actions = [];
  if (Array.isArray(parsed.actions) && parsed.actions.length > 0) {
    actions = parsed.actions.map(act => ({
      action: act.action || act.type || 'REFACTOR_CODE',
      target: act.target || act.filePath || act.file || parsed.target,
      lineEdits: (act.lineEdits || act.edits || []).map(e => ({
        startLine: Number(e.startLine),
        endLine: Number(e.endLine),
        replacement: e.replacement
      })),
      replacementCode: act.replacementCode || act.code || null,
      envKey: act.envKey || null,
      explanation: act.explanation || parsed.explanation || 'Self-healing patch synthesized'
    }));
  } else if (parsed.action || parsed.target) {
    actions = [{
      action: parsed.action || 'REFACTOR_CODE',
      target: parsed.target,
      lineEdits: (parsed.lineEdits || parsed.edits || []).map(e => ({
        startLine: Number(e.startLine),
        endLine: Number(e.endLine),
        replacement: e.replacement
      })),
      replacementCode: parsed.replacementCode || null,
      envKey: parsed.envKey || null,
      explanation: parsed.explanation || 'Self-healing patch synthesized'
    }];
  }

  const primaryAction = actions[0] || {};
  return {
    action: primaryAction.action || 'REFACTOR_CODE',
    target: primaryAction.target,
    lineEdits: primaryAction.lineEdits || [],
    replacementCode: primaryAction.replacementCode || null,
    envKey: primaryAction.envKey || null,
    explanation: parsed.explanation || primaryAction.explanation || 'Self-healing patch synthesized',
    actions: actions
  };
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
    req.on('error', (err) => resolve({ error: `Network error: ${err?.message || 'Connection failed'}` }));
    req.setTimeout(12000, () => { req.destroy(); resolve({ error: 'Network error: Gemini API request timed out after 12s' }); });
    req.write(payload);
    req.end();
  });
}

async function callGeminiApi(apiKey, model, logText, context) {
  if (!apiKey) return { error: 'NO_API_KEY: Gemini API Key missing.' };

  const primaryModel = model || 'gemini-3.5-flash';
  const fallbackCandidates = [primaryModel, 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite'].filter((m, idx, self) => m && self.indexOf(m) === idx);

  let lastResult = null;
  for (const targetModel of fallbackCandidates) {
    const result = await callGeminiApiSingle(apiKey, targetModel, logText, context);
    if (result && !result.error) return result;
    lastResult = result;
    if (result?.error && (result.error.includes('NO_API_KEY') || result.error.includes('INVALID_KEY'))) return result;
    if (result?.error && result.error.includes('503')) {
      await new Promise(r => setTimeout(r, 600));
    }
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
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve({ error: `API Error (HTTP ${res.statusCode}): ${body.slice(0, 300)}` });
        try {
          const parsed = JSON.parse(body);
          const text = parsed.choices?.[0]?.message?.content || '';
          resolve(parseLlmJson(text));
        } catch { resolve(null); }
      });
    });
    req.on('error', (err) => resolve({ error: `Network error: ${err?.message || 'Connection failed'}` }));
    req.setTimeout(12000, () => { req.destroy(); resolve({ error: 'Network error: OpenAI API request timed out after 12s' }); });
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
