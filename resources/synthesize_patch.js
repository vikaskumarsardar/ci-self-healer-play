const fs = require('fs');
const path = require('path');
const { getArgValue, resolveWorkspaceCwd } = require('./lib/workspace');
const { resolveVerificationCommands } = require('./lib/ecosystem');
const { resolveApiKey, callGeminiApi, callOpenAiApi } = require('./lib/llm_client');
const { isSafePath, PatchManager } = require('./lib/patch_applier');

const cwd = resolveWorkspaceCwd();

const rawLogFile = getArgValue('log_file');
const logFilePath = (rawLogFile && !rawLogFile.startsWith('$') && rawLogFile.trim() !== '' && rawLogFile !== 'undefined') ? path.resolve(rawLogFile.trim()) : null;

const rawApiKey = getArgValue('api_key');
let apiKeyArg = (rawApiKey && rawApiKey.trim() !== '' && rawApiKey !== 'undefined' && rawApiKey !== 'null') ? rawApiKey.trim() : null;
const apiKey = resolveApiKey(apiKeyArg, cwd);

const rawModel = getArgValue('model');
const modelArg = (rawModel && !rawModel.startsWith('$') && rawModel.trim() !== '' && rawModel !== 'undefined' && rawModel !== 'null') ? rawModel.trim() : null;

const rawBaseUrl = getArgValue('base_url');
let baseUrlArg = (rawBaseUrl && !rawBaseUrl.startsWith('$') && rawBaseUrl.trim() !== '' && rawBaseUrl !== 'undefined' && rawBaseUrl !== 'null') ? rawBaseUrl.trim() : null;

const rawProvider = getArgValue('provider');
const providerArg = (rawProvider && !rawProvider.startsWith('$') && rawProvider.trim() !== '' && rawProvider !== 'undefined' && rawProvider !== 'null') ? rawProvider.trim().toLowerCase() : null;

let provider = providerArg || process.env.LLM_PROVIDER;
if (!provider) {
  if (apiKey && apiKey.startsWith('sk-')) provider = 'openai';
  else if (apiKey && apiKey.startsWith('AIza')) provider = 'gemini';
  else provider = 'openai';
}

if (baseUrlArg && (baseUrlArg.includes('11434') || baseUrlArg.includes('localhost') || baseUrlArg.includes('127.0.0.1')) && provider !== 'ollama' && apiKey && (apiKey.startsWith('sk-') || apiKey.startsWith('AIza'))) {
  baseUrlArg = null;
}

const isGemini = provider === 'gemini';
let model = modelArg || process.env.LLM_MODEL || (isGemini ? 'gemini-1.5-flash' : 'gpt-4o-mini');

let rawLogText = '';
if (logFilePath && fs.existsSync(logFilePath)) {
  rawLogText = fs.readFileSync(logFilePath, 'utf8');
} else {
  const roteLogPath = path.join(cwd, '.rote', 'raw_captured_log.txt');
  if (fs.existsSync(roteLogPath)) rawLogText = fs.readFileSync(roteLogPath, 'utf8');
}

function redactSecrets(text) {
  if (!text) return '';
  return text
    .replace(/(AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|SECRET|TOKEN|API_KEY|PASSWORD|DATABASE_URL)=['"]?[^\s'"]+['"]?/gi, '$1=[REDACTED_SECRET]')
    .replace(/(AKIA[0-9A-Z]{16})/g, '[REDACTED_AWS_KEY]');
}

function getStackFocusedContext(logText) {
  const fileLineMatches = [...logText.matchAll(/([a-zA-Z0-9_\-\.\/]+\.(?:js|ts|jsx|tsx|py|go|rs)):(\d+)/g)];
  let focusedFiles = [];

  for (const m of fileLineMatches) {
    const relFile = m[1].replace(/^[\[\(]/, '');
    const lineNo = parseInt(m[2], 10);
    if (isSafePath(cwd, relFile)) {
      const fullP = path.resolve(cwd, relFile);
      if (fs.existsSync(fullP)) {
        const lines = fs.readFileSync(fullP, 'utf8').split('\n');
        const start = Math.max(0, lineNo - 30);
        const end = Math.min(lines.length, lineNo + 30);
        const snippet = lines.slice(start, end).map((l, i) => `${start + i + 1}: ${l}`).join('\n');
        focusedFiles.push(`--- HIGH PRIORITY FAILING FILE: ${relFile} (Lines ${start+1}-${end}) ---\n${snippet}`);
      }
    }
  }
  return focusedFiles.join('\n\n');
}

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
        } catch {}
      }
    }
  }
  return fileList;
}

const { execSync } = require('child_process');
function runLocalVerification() {
  const cmds = resolveVerificationCommands(cwd);
  if (cmds.length === 0) return { passed: false, errorLog: 'No verification command detected' };
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

async function main() {
  const startTime = Date.now();
  let autoHealed = false;
  let healedActionDetails = null;
  let requiresSecret = false;
  let errorReason = null;
  let finalDiagnosis = null;
  let attemptsCount = 0;
  let previousErrorLog = '';

  const patchManager = new PatchManager(cwd);
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attemptsCount = attempt;
    
    const currentLogText = attempt === 1 
      ? cleanRawLogText 
      : `${cleanRawLogText}\n\n--- PREVIOUS ATTEMPT ${attempt - 1} PATCH FAILED WITH ERROR ---\n${redactSecrets(previousErrorLog)}`;

    const focusedContext = redactSecrets(getStackFocusedContext(currentLogText));
    const projectFiles = getProjectFiles(cwd).filter(f => !focusedContext.includes(`--- HIGH PRIORITY FAILING FILE: ${f.path}`));
    const filesContext = (focusedContext ? focusedContext + '\n\n' : '') + projectFiles.map(f => {
      const numberedContent = f.content.slice(0, 3000).split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n');
      return `--- FILE: ${f.path} ---\n${redactSecrets(numberedContent)}`;
    }).join('\n\n');

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

    finalDiagnosis = aiDiagnosis;
    const patchRes = patchManager.applyPatch(aiDiagnosis);

    if (patchRes.applied) {
      const verifyCheck = runLocalVerification();
      if (verifyCheck.passed) {
        autoHealed = true;
        healedActionDetails = `Self-healing patch applied and verified (Attempt ${attempt} of ${maxAttempts})`;
        break;
      } else {
        previousErrorLog = verifyCheck.errorLog;
        patchManager.revertBackups();
        if (attempt === maxAttempts) {
          errorReason = `Self-healing retry limit reached (${maxAttempts} attempts executed without full verification)`;
        }
      }
    } else if (aiDiagnosis.action === 'SYNC_ENV_KEY' && aiDiagnosis.envKey) {
      autoHealed = false;
      requiresSecret = true;
      healedActionDetails = `Identified missing environment key: ${aiDiagnosis.envKey}`;
      break;
    } else {
      errorReason = patchRes.error || 'Failed to apply patch';
      break;
    }
  }

  if (!autoHealed) {
    patchManager.revertBackups();
  }

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(1) + 's';
  const isError = (errorReason || !autoHealed);
  process.stdout.write(JSON.stringify({
    status: isError ? 'REJECTED' : 'DIAGNOSED',
    engine: finalDiagnosis ? (isGemini ? 'GEMINI_CLOUD_LLM' : (baseUrlArg ? 'CUSTOM_OPENAI_COMPATIBLE_LLM' : 'OPENAI_CLOUD_LLM')) : 'NO_LLM_DIAGNOSIS',
    model,
    aiDiagnosis: finalDiagnosis,
    autoHealed,
    requiresSecret,
    healedActionDetails,
    errorReason: errorReason || (apiKey ? 'LLM diagnosis unavailable' : 'No LLM API key configured. Please set OPENAI_API_KEY or GEMINI_API_KEY environment variable, or pass api_key=...'),
    durationSec,
    attemptsExecuted: attemptsCount,
    targetFile: finalDiagnosis?.target || null,
    cwd
  }));

  if (isError) process.exit(1);
}

main();
