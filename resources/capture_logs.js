const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function getArgValue(name) {
  const arg = process.argv.find(a => a.startsWith(`${name}=`));
  return arg ? arg.slice(name.length + 1) : undefined;
}

function resolveWorkspaceCwd() {
  const rawTargetDir = getArgValue('target_dir');
  if (rawTargetDir && rawTargetDir.trim() !== '' && rawTargetDir !== 'undefined' && rawTargetDir !== 'null' && !rawTargetDir.startsWith('$')) {
    const target = rawTargetDir.trim();
    const abs = path.isAbsolute(target) ? target : path.resolve(process.cwd(), target);
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) return abs;
  }

  let baseDir = process.cwd();
  if (process.env.GITHUB_WORKSPACE && fs.existsSync(process.env.GITHUB_WORKSPACE)) {
    baseDir = process.env.GITHUB_WORKSPACE;
  } else if (process.env.PWD && fs.existsSync(process.env.PWD) && !process.env.PWD.includes('.rote/workspaces')) {
    baseDir = process.env.PWD;
  } else if (process.env.INIT_CWD && fs.existsSync(process.env.INIT_CWD) && !process.env.INIT_CWD.includes('.rote/workspaces')) {
    baseDir = process.env.INIT_CWD;
  }

  return path.resolve(baseDir);
}

const cwd = resolveWorkspaceCwd();

const rawLogFile = getArgValue('log_file');
const logFilePath = (rawLogFile && !rawLogFile.startsWith('$') && rawLogFile.trim() !== '' && rawLogFile !== 'undefined' && rawLogFile !== 'null') ? path.resolve(rawLogFile.trim()) : null;

let rawLogText = '';

if (logFilePath && fs.existsSync(logFilePath)) {
  rawLogText = fs.readFileSync(logFilePath, 'utf8');
} else {
  function resolveProjectRoot(dir) {
  const target = path.resolve(dir || '.');
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) return target;
  return target;
}

const resolvedCwd = resolveProjectRoot(cwd);
const files = fs.existsSync(resolvedCwd) ? fs.readdirSync(resolvedCwd) : [];
  let buildCmd = '';
  let testCmd = '';

  if (files.includes('package.json')) {
    try {
      const pkgJson = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
      if (pkgJson.scripts?.build) buildCmd = 'npm run build';
      if (pkgJson.scripts?.test && !pkgJson.scripts.test.includes('no test specified')) {
        testCmd = 'npm test';
      } else if (pkgJson.scripts?.lint) {
        testCmd = 'npm run lint';
      } else {
        testCmd = 'node --test 2>/dev/null || node test.js';
      }
    } catch {
      testCmd = 'npm test';
    }
  } else if (files.includes('go.mod') || files.some(f => f.endsWith('.go'))) {
    testCmd = 'go test ./...';
  } else if (files.includes('requirements.txt') || files.includes('pytest.ini') || files.includes('pyproject.toml') || files.includes('setup.py') || files.includes('Pipfile') || files.includes('tox.ini') || files.some(f => f.endsWith('.py'))) {
    testCmd = 'python3 -m unittest discover 2>&1 || pytest';
  } else if (files.includes('Cargo.toml')) {
    testCmd = 'cargo test';
  } else if (files.includes('Gemfile') || files.includes('Rakefile') || files.some(f => f.endsWith('.rb'))) {
    testCmd = 'ruby -e "Dir.glob(\'./**/*_test.rb\').each { |f| require f }"';
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
