const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function getArgValue(name) {
  const arg = process.argv.find(a => a.startsWith(`${name}=`));
  return arg ? arg.slice(name.length + 1) : undefined;
}

function resolveWorkspaceCwd() {
  const rawTargetDir = getArgValue('target_dir');
  if (rawTargetDir && rawTargetDir.trim() !== '' && rawTargetDir !== 'undefined' && rawTargetDir !== 'null' && rawTargetDir !== '.') {
    const abs = path.resolve(rawTargetDir.trim());
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) return abs;
  }
  if (process.env.GITHUB_WORKSPACE && fs.existsSync(process.env.GITHUB_WORKSPACE)) {
    return process.env.GITHUB_WORKSPACE;
  }
  let curr = process.cwd();
  if (curr.includes(path.join('.rote', 'artifacts'))) {
    curr = curr.split(path.join('.rote', 'artifacts'))[0];
  }
  return path.resolve(curr);
}

const cwd = resolveWorkspaceCwd();

const rawLogFile = getArgValue('log_file');
const logFilePath = (rawLogFile && rawLogFile.trim() !== '' && rawLogFile !== 'undefined') ? path.resolve(rawLogFile.trim()) : null;

let rawLogText = '';

if (logFilePath && fs.existsSync(logFilePath)) {
  rawLogText = fs.readFileSync(logFilePath, 'utf8');
} else {
  const files = fs.existsSync(cwd) ? fs.readdirSync(cwd) : [];
  let buildCmd = '';
  let testCmd = '';

  if (files.includes('package.json')) {
    try {
      const pkgJson = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
      if (pkgJson.scripts?.build) buildCmd = 'npm run build';
      if (pkgJson.scripts?.test) testCmd = 'npm test';
    } catch {
      testCmd = 'npm test';
    }
  } else if (files.includes('go.mod') || files.some(f => f.endsWith('.go'))) {
    testCmd = 'go test ./...';
  } else if (files.includes('requirements.txt') || files.includes('pytest.ini') || files.includes('pyproject.toml') || files.includes('setup.py') || files.includes('Pipfile') || files.includes('tox.ini')) {
    testCmd = 'pytest';
  } else if (files.includes('Cargo.toml')) {
    testCmd = 'cargo test';
  }

  const commandsToRun = [buildCmd, testCmd].filter(Boolean);

  for (const cmd of commandsToRun) {
    try {
      const out = execSync(cmd, { cwd, stdio: 'pipe', encoding: 'utf8' }).toString();
      rawLogText += `\n=== COMMAND: ${cmd} ===\n` + out;
    } catch (err) {
      const errOut = err.stdout ? err.stdout.toString() : '';
      const errErr = err.stderr ? err.stderr.toString() : '';
      const combined = (errOut + '\n' + errErr).trim() || err.message;
      rawLogText += `\n=== COMMAND FAILED: ${cmd} ===\n` + combined;
      break;
    }
  }
}

try {
  console.error(`[capture_logs DEBUG] cwd=${cwd}, rawLogLength=${rawLogText ? rawLogText.length : 0}`);
} catch {}

// Persist captured raw log for downstream pure LLM synthesis
try {
  const roteTempDir = path.join(cwd, '.rote');
  fs.mkdirSync(roteTempDir, { recursive: true });
  fs.writeFileSync(path.join(roteTempDir, 'raw_captured_log.txt'), rawLogText);
} catch {
  // Graceful fallback
}

process.stdout.write(JSON.stringify({
  status: 'CAPTURED',
  rawLogLength: rawLogText.length,
  logSnippet: rawLogText.slice(0, 500)
}));
