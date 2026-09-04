const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { execFileSync, execSync } = require('child_process');

function getArgValue(name) {
  const arg = process.argv.find(a => a.startsWith(`${name}=`));
  return arg ? arg.slice(name.length + 1) : undefined;
}

function resolveWorkspaceCwd() {
  const rawTargetDir = getArgValue('target_dir');
  let baseDir = process.cwd();
  if (process.env.GITHUB_WORKSPACE && fs.existsSync(process.env.GITHUB_WORKSPACE)) {
    baseDir = process.env.GITHUB_WORKSPACE;
  } else if (process.env.INIT_CWD && fs.existsSync(process.env.INIT_CWD)) {
    baseDir = process.env.INIT_CWD;
  } else if (process.env.PWD && fs.existsSync(process.env.PWD) && !process.env.PWD.includes('.rote/workspaces')) {
    baseDir = process.env.PWD;
  }

  if (rawTargetDir && rawTargetDir.trim() !== '' && rawTargetDir !== 'undefined' && rawTargetDir !== 'null') {
    const target = rawTargetDir.trim();
    const abs = path.isAbsolute(target) ? target : path.resolve(baseDir, target);
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) return abs;
  }

  if (process.env.GITHUB_WORKSPACE && fs.existsSync(process.env.GITHUB_WORKSPACE)) {
    return process.env.GITHUB_WORKSPACE;
  }

  return path.resolve(baseDir);
}

const cwd = resolveWorkspaceCwd();

const rawLogFile = getArgValue('log_file');
const logFilePath = (rawLogFile && rawLogFile.trim() !== '' && rawLogFile !== 'undefined') ? path.resolve(rawLogFile.trim()) : null;

const rawApiKey = getArgValue('api_key');
let apiKeyArg = (rawApiKey && rawApiKey.trim() !== '' && rawApiKey !== 'undefined' && rawApiKey !== 'null') ? rawApiKey.trim() : null;

if (apiKeyArg && apiKeyArg.startsWith('$')) {
  const envName = apiKeyArg.slice(1);
  apiKeyArg = process.env[envName] || null;
}

const apiKey = (apiKeyArg && !apiKeyArg.startsWith('$'))
  ? apiKeyArg
  : (process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY || process.env.LLM_API_KEY || process.env.api_key || null);

const rawModel = getArgValue('model');
const modelArg = (rawModel && !rawModel.startsWith('$') && rawModel.trim() !== '' && rawModel !== 'undefined' && rawModel !== 'null') ? rawModel.trim() : null;

const rawBaseUrl = getArgValue('base_url');
const baseUrlArg = (rawBaseUrl && !rawBaseUrl.startsWith('$') && rawBaseUrl.trim() !== '' && rawBaseUrl !== 'undefined' && rawBaseUrl !== 'null') ? rawBaseUrl.trim() : null;

const rawProvider = getArgValue('provider');
const providerArg = (rawProvider && !rawProvider.startsWith('$') && rawProvider.trim() !== '' && rawProvider !== 'undefined' && rawProvider !== 'null') ? rawProvider.trim() : null;

const provider = providerArg || process.env.LLM_PROVIDER || (apiKey && (apiKey.startsWith('AQ') || apiKey.startsWith('AIza')) ? 'gemini' : 'openai');
const isGemini = provider === 'gemini';

let model = modelArg || process.env.LLM_MODEL || (isGemini ? 'gemini-3.7-flash' : 'gpt-4o-mini');

try {
  console.error(`[synthesize_patch DEBUG] cwd=${cwd}, hasApiKey=${Boolean(apiKey)}, apiKeyLength=${apiKey ? apiKey.length : 0}, provider=${provider}, model=${model}`);
} catch {}

let rawLogText = '';
if (logFilePath && fs.existsSync(logFilePath)) {
  rawLogText = fs.readFileSync(logFilePath, 'utf8');
} else {
  const roteLogPath = path.join(cwd, '.rote', 'raw_captured_log.txt');
  if (fs.existsSync(roteLogPath)) {
    rawLogText = fs.readFileSync(roteLogPath, 'utf8');
  }
}

// 🛡️ Security Check: Correct Capturing Group Redaction for AWS Keys, Passwords & Tokens
function redactSecrets(text) {
  if (!text) return '';
  return text
    .replace(/(AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|SECRET|TOKEN|API_KEY|PASSWORD|DATABASE_URL)=['"]?[^\s'"]+['"]?/gi, '$1=[REDACTED_SECRET]')
    .replace(/(AKIA[0-9A-Z]{16})/g, '[REDACTED_AWS_KEY]');
}

// 🛡️ Security Check: Path Traversal Boundary Validation
function isSafePath(targetPath) {
  if (!targetPath) return false;
  const resolved = path.resolve(cwd, targetPath);
  const relative = path.relative(cwd, resolved);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

// 🛡️ Security Check: Strict Package Spec Validation (Reject suspicious shell characters instead of mutating)
function sanitizePackageName(pkg) {
  if (!pkg) return null;
  const trimmed = pkg.trim();
  if (/^[a-zA-Z0-9_\-\/@\.]+$/.test(trimmed)) {
    return trimmed;
  }
  return null;
}

// 🎯 Stack Trace Line Extractor: Extract high-priority line window (+/- 30 lines) around failing lines
function getStackFocusedContext(logText) {
  const fileLineMatches = [...logText.matchAll(/([a-zA-Z0-9_\-\.\/]+\.(?:js|ts|jsx|tsx|py|go|rs)):(\d+)/g)];
  let focusedFiles = [];

  for (const m of fileLineMatches) {
    const relFile = m[1].replace(/^[\[\(]/, '');
    const lineNo = parseInt(m[2], 10);
    if (isSafePath(relFile)) {
      const fullP = path.resolve(cwd, relFile);
      if (fs.existsSync(fullP)) {
        const lines = fs.readFileSync(fullP, 'utf8').split('\n');
        const start = Math.max(0, lineNo - 30);
        const end = Math.min(lines.length, lineNo + 30);
        const snippet = lines.slice(start, end).join('\n');
        focusedFiles.push(`--- HIGH PRIORITY FAILING FILE: ${relFile} (Lines ${start+1}-${end}) ---\n${snippet}`);
      }
    }
  }
  return focusedFiles.join('\n\n');
}

// 🛡️ Explicit Secret File Exclusion Set
const secretFiles = new Set(['.env', '.env.local', '.env.production', '.env.staging', 'credentials.json', 'service-account.json', 'secrets.yaml', 'id_rsa']);
const binaryExts = ['.png', '.jpg', '.jpeg', '.gif', '.ico', '.pdf', '.zip', '.tar', '.gz', '.woff', '.woff2', '.ttf', '.eot', '.lock', '.pem', '.key'];

function getProjectFiles(dir, fileList = []) {
  if (!fs.existsSync(dir)) return fileList;
  const items = fs.readdirSync(dir, { withFileTypes: true });
  for (const item of items) {
    if (item.name === 'node_modules' || item.name === '.git' || item.name === 'dist' || item.name === '.rote' || item.name === 'build' || item.name.startsWith('.')) continue;
    if (secretFiles.has(item.name.toLowerCase())) continue;
    const fullPath = path.join(dir, item.name);
    if (item.isDirectory()) {
      getProjectFiles(fullPath, fileList);
    } else {
      const ext = path.extname(item.name).toLowerCase();
      if (!binaryExts.includes(ext) && !item.name.endsWith('.pem') && !item.name.endsWith('.key')) {
        try {
          const relPath = path.relative(cwd, fullPath);
          fileList.push({ path: relPath, content: fs.readFileSync(fullPath, 'utf8') });
        } catch { /* Skip unreadable binary files */ }
      }
    }
  }
  return fileList;
}

// Deterministic local verification check for the retry feedback loop (Fail-Closed Guard)
function runLocalVerification() {
  const dirFiles = fs.existsSync(cwd) ? fs.readdirSync(cwd) : [];
  const cmds = [];

  if (dirFiles.includes('package.json')) {
    try {
      const pkgJson = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
      if (pkgJson.scripts?.lint) cmds.push('npm run lint');
      if (pkgJson.scripts?.typecheck) cmds.push('npm run typecheck');
      if (pkgJson.scripts?.build) cmds.push('npm run build');
      if (pkgJson.scripts?.test) cmds.push('npm test');
    } catch { cmds.push('npm test'); }
  } else if (dirFiles.includes('go.mod')) {
    cmds.push('go test ./...');
  } else if (dirFiles.includes('requirements.txt') || dirFiles.includes('pytest.ini')) {
    cmds.push('pytest');
  } else if (dirFiles.includes('Cargo.toml')) {
    cmds.push('cargo test');
  }

  // 🛡️ Fail-Closed Integrity Guard: Empty verification commands must NOT return true
  if (cmds.length === 0) {
    return {
      passed: false,
      errorLog: 'No deterministic verification command detected in target directory'
    };
  }

  let errorLog = '';
  for (const c of cmds) {
    try {
      execSync(c, { cwd, stdio: 'pipe' });
    } catch (err) {
      const errOut = err.stdout ? err.stdout.toString() : '';
      const errErr = err.stderr ? err.stderr.toString() : '';
      errorLog = (errOut + '\n' + errErr).trim() || err.message;
      return { passed: false, errorLog };
    }
  }
  return { passed: true, errorLog: '' };
}

const cleanRawLogText = redactSecrets(rawLogText);

const SYSTEM_PROMPT = `You are an Autonomous CI/CD Self-Healing AI Engine.
Analyze the CI error log and project files below.
Determine which file contains the error, diagnose the root cause, and produce a structured fix.

GUIDANCE:
- PREFER "lineEdits" for localized bug fixes and line replacements.
- Ensure lineEdits do NOT overlap with each other and stay strictly within file line bounds.
- Use "replacementCode" ONLY when an entire file genuinely needs total replacement or new file creation.
- Never modify unrelated code.
- Preserve developer intent: when resolving variable redeclarations or naming collisions, prefer renaming the variable (e.g. const appName = ...) or adjusting scope/types over deleting lines, unless the line is an obvious accidental duplicate.

Return ONLY raw JSON matching this exact schema:
{
  "action": "INSTALL_DEPENDENCY" | "REFACTOR_CODE" | "SYNC_ENV_KEY" | "FIX_CONFIG",
  "target": "relative/file/path/or/package_name",
  "lineEdits": [{ "startLine": number, "endLine": number, "replacement": "string" }],
  "replacementCode": "Complete repaired source code or new file content if lineEdits is null",
  "envKey": "Key name if action is SYNC_ENV_KEY, otherwise null",
  "explanation": "Brief description of the diagnosis and fix"
}`;

// Robust JSON parser for LLM markdown outputs
function parseLlmJson(rawText) {
  if (!rawText) return null;
  let cleaned = rawText.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch {
        try {
          const sanitized = jsonMatch[0].replace(/([^\\])\r?\n/g, '$1\\n');
          return JSON.parse(sanitized);
        } catch { return null; }
      }
    }
    return null;
  }
}

function callGeminiApiSingle(apiKey, model, logText, context) {
  return new Promise((resolve) => {
    if (!apiKey) return resolve(null);
    const targetModel = model || 'gemini-3.7-flash';
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
            if (parsed.error?.status === 'RESOURCE_EXHAUSTED' || res.statusCode === 429) {
              const retryMatch = (parsed.error?.message || '').match(/retry in ([\d\.]+)s/i);
              const retrySec = retryMatch ? Math.ceil(parseFloat(retryMatch[1])) : 60;
              msg = `Gemini Rate Limit Exceeded (HTTP 429)\n                       ↳ Free tier limit reached (20 req/min)\n                       ↳ Action: Retry in ${retrySec} seconds`;
            } else if (parsed.error?.message) {
              msg = `API Error (HTTP ${res.statusCode}): ${parsed.error.message.slice(0, 100)}`;
            }
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
    req.on('error', (e) => {
      try { console.error(`[Gemini ${targetModel} Request Error]:`, e.message); } catch {}
      resolve(null);
    });
    req.setTimeout(45000, () => {
      try { console.error(`[Gemini ${targetModel} Timeout after 45s]`); } catch {}
      req.destroy();
      resolve(null);
    });
    req.write(payload);
    req.end();
  });
}

async function callGeminiApi(apiKey, model, logText, context) {
  const targetModel = model || 'gemini-2.0-flash';
  try { console.error(`[Gemini LLM] Querying model ${targetModel}...`); } catch {}
  return await callGeminiApiSingle(apiKey, targetModel, logText, context);
}

function callOpenAiApi(apiKey, model, logText, context, customBaseUrl) {
  return new Promise((resolve) => {
    let hostname = 'api.openai.com';
    let pathName = '/v1/chat/completions';
    let isHttps = true;

    if (customBaseUrl) {
      try {
        const parsedUrl = new URL(customBaseUrl);
        hostname = parsedUrl.hostname;
        pathName = parsedUrl.pathname.endsWith('/chat/completions') ? parsedUrl.pathname : pathName;
        isHttps = parsedUrl.protocol === 'https:';
      } catch { /* Fallback */ }
    }

    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const options = { hostname, path: pathName, method: 'POST', headers };
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

async function main() {
  const startTime = Date.now();
  let autoHealed = false;
  let healedActionDetails = null;
  let requiresSecret = false;
  let errorReason = null;
  let finalDiagnosis = null;
  let attemptsCount = 0;
  let previousErrorLog = '';

  const validActions = ['INSTALL_DEPENDENCY', 'REFACTOR_CODE', 'SYNC_ENV_KEY', 'FIX_CONFIG'];
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attemptsCount = attempt;
    
    // Re-evaluate context & stack focus with feedback from previous attempt if available
    const currentLogText = attempt === 1 
      ? cleanRawLogText 
      : `${cleanRawLogText}\n\n--- PREVIOUS ATTEMPT ${attempt - 1} PATCH FAILED WITH COMPILER/TEST ERROR ---\n${redactSecrets(previousErrorLog)}`;

    const focusedContext = redactSecrets(getStackFocusedContext(currentLogText));
    const projectFiles = getProjectFiles(cwd);
    const filesContext = focusedContext + '\n\n' + projectFiles.map(f => `--- FILE: ${f.path} ---\n${redactSecrets(f.content.slice(0, 2500))}`).join('\n\n');

    let aiDiagnosis = null;
    if (apiKey && cleanRawLogText) {
      if (isGemini) {
        aiDiagnosis = await callGeminiApi(apiKey, model, currentLogText, filesContext);
      } else {
        aiDiagnosis = await callOpenAiApi(apiKey, model, currentLogText, filesContext, baseUrlArg);
      }
    }

    if (!aiDiagnosis || aiDiagnosis.error) {
      errorReason = aiDiagnosis?.error || (apiKey ? 'LLM diagnosis unavailable or invalid' : 'No LLM API key configured');
      finalDiagnosis = null;
      break;
    }

    // Normalize action and default missing targets before validation
    let actionNorm = (aiDiagnosis.action || '').toUpperCase().trim();
    if (!actionNorm || actionNorm === 'REFACTOR' || actionNorm === 'MODIFY' || actionNorm === 'FIX' || actionNorm === 'MODIFY_CODE' || actionNorm === 'UPDATE_FILE' || actionNorm === 'FIX_SYNTAX' || actionNorm === 'REFACTOR_CODE') {
      if (Array.isArray(aiDiagnosis.lineEdits) || aiDiagnosis.replacementCode || aiDiagnosis.target) {
        actionNorm = 'REFACTOR_CODE';
        aiDiagnosis.action = 'REFACTOR_CODE';
      }
    }

    if (!validActions.includes(actionNorm)) {
      errorReason = `Unsupported AI action: ${aiDiagnosis.action}`;
      break;
    } else if (actionNorm === 'INSTALL_DEPENDENCY' && !aiDiagnosis.target) {
      errorReason = 'INSTALL_DEPENDENCY requires a target package specification';
      break;
    } else if ((actionNorm === 'REFACTOR_CODE' || actionNorm === 'FIX_CONFIG') && !aiDiagnosis.target) {
      // Auto-fallback target if Gemini omitted target field but provided line edits
      if (targetFiles.length > 0) {
        aiDiagnosis.target = targetFiles[0];
      } else {
        errorReason = `${actionNorm} requires a target file specification`;
        break;
      }
    } else if (actionNorm === 'SYNC_ENV_KEY' && !aiDiagnosis.envKey) {
      errorReason = 'SYNC_ENV_KEY requires an envKey specification';
      break;
    }

    let patchApplied = false;

    // 1. Action: INSTALL_DEPENDENCY
    if (actionNorm === 'INSTALL_DEPENDENCY') {
      const sanitizedPkg = sanitizePackageName(aiDiagnosis.target);
      if (sanitizedPkg) {
        try {
          if (fs.existsSync(path.join(cwd, 'package.json'))) {
            execFileSync('npm', ['install', sanitizedPkg], { cwd, stdio: 'pipe' });
            patchApplied = true;
          } else if (fs.existsSync(path.join(cwd, 'go.mod'))) {
            execFileSync('go', ['get', sanitizedPkg], { cwd, stdio: 'pipe' });
            patchApplied = true;
          } else if (fs.existsSync(path.join(cwd, 'requirements.txt'))) {
            execFileSync('pip', ['install', sanitizedPkg], { cwd, stdio: 'pipe' });
            patchApplied = true;
          } else if (fs.existsSync(path.join(cwd, 'Cargo.toml'))) {
            execFileSync('cargo', ['add', sanitizedPkg], { cwd, stdio: 'pipe' });
            patchApplied = true;
          }
        } catch { patchApplied = false; }

        if (!patchApplied) {
          errorReason = `Package installation failed or no matching package manifest found for: ${sanitizedPkg}`;
          break;
        }
      } else {
        errorReason = `Suspicious or invalid package specification rejected: ${aiDiagnosis.target}`;
        break;
      }
    }
    // 2. Action: REFACTOR_CODE or FIX_CONFIG
    else if (actionNorm === 'REFACTOR_CODE' || actionNorm === 'FIX_CONFIG') {
      const fileTarget = aiDiagnosis.target.trim();
      if (isSafePath(fileTarget)) {
        const fileToPatch = path.resolve(cwd, fileTarget);

        if (fs.existsSync(fileToPatch)) {
          if (Array.isArray(aiDiagnosis.lineEdits) && aiDiagnosis.lineEdits.length > 0 && aiDiagnosis.lineEdits.length <= 20) {
            let lines = fs.readFileSync(fileToPatch, 'utf8').split('\n');
            const invalidEdits = aiDiagnosis.lineEdits.some(e => 
              !Number.isInteger(e.startLine) || 
              !Number.isInteger(e.endLine) || 
              typeof e.replacement !== 'string' || 
              e.startLine > lines.length || 
              e.endLine > lines.length || 
              e.startLine < 1 || 
              e.endLine < e.startLine
            );

            if (invalidEdits) {
              errorReason = `Line edit type mismatch or out of bounds for target file (length: ${lines.length})`;
              break;
            } else {
              const sortedEdits = [...aiDiagnosis.lineEdits].sort((a, b) => b.startLine - a.startLine);
              let hasOverlap = false;
              let lastStart = Infinity;
              
              for (const edit of sortedEdits) {
                if (edit.endLine >= lastStart) {
                  hasOverlap = true;
                  break;
                }
                lastStart = edit.startLine;
              }

              if (hasOverlap) {
                errorReason = `Overlapping line edits detected; patch rejected for safety`;
                break;
              } else {
                for (const edit of sortedEdits) {
                  const start = Math.max(0, edit.startLine - 1);
                  const end = Math.min(lines.length, edit.endLine);
                  lines.splice(start, end - start, edit.replacement);
                }
                fs.writeFileSync(fileToPatch, lines.join('\n'));
                patchApplied = true;
              }
            }
          } else if (aiDiagnosis.replacementCode) {
            fs.writeFileSync(fileToPatch, aiDiagnosis.replacementCode);
            patchApplied = true;
          } else {
            errorReason = `No valid lineEdits or replacementCode provided for target file: ${fileTarget}`;
            break;
          }
        } else if (aiDiagnosis.replacementCode) {
          fs.mkdirSync(path.dirname(fileToPatch), { recursive: true });
          fs.writeFileSync(fileToPatch, aiDiagnosis.replacementCode);
          patchApplied = true;
        } else {
          errorReason = `Cannot create new file without replacementCode for target: ${fileTarget}`;
          break;
        }
      } else {
        errorReason = `Path traversal security violation for target: ${fileTarget}`;
        break;
      }
    }
    // 3. Action: SYNC_ENV_KEY
    else if (actionNorm === 'SYNC_ENV_KEY') {
      const envKeyClean = aiDiagnosis.envKey.replace(/[^a-zA-Z0-9_]/g, '');
      if (envKeyClean) {
        autoHealed = false;
        requiresSecret = true;
        healedActionDetails = `Identified missing environment key: ${envKeyClean} (Requires CI Secret Store configuration)`;
        break;
      }
    }

    // Run deterministic local verification feedback check
    if (patchApplied) {
      const verifyCheck = runLocalVerification();
      if (verifyCheck.passed) {
        autoHealed = true;
        healedActionDetails = `Self-healing patch applied and verified (Attempt ${attempt} of ${maxAttempts})`;
        break; // Verification passed!
      } else {
        previousErrorLog = verifyCheck.errorLog;
        if (attempt === maxAttempts) {
          errorReason = `Self-healing retry limit reached (${maxAttempts} attempts executed without full verification)`;
        }
      }
    }
  }

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(1) + 's';
  process.stdout.write(JSON.stringify({
    status: errorReason ? 'REJECTED' : 'DIAGNOSED',
    engine: finalDiagnosis ? (isGemini ? 'GEMINI_CLOUD_LLM' : (baseUrlArg ? 'CUSTOM_OPENAI_COMPATIBLE_LLM' : 'OPENAI_CLOUD_LLM')) : 'NO_LLM_DIAGNOSIS',
    model,
    aiDiagnosis: finalDiagnosis,
    autoHealed,
    requiresSecret,
    healedActionDetails,
    errorReason,
    durationSec,
    attemptsExecuted: attemptsCount,
    targetFile: finalDiagnosis?.target || null,
    cwd
  }));
}

main();
