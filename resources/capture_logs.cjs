const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { getArgValue, resolveWorkspaceCwd } = require('./lib/workspace.cjs');
const { resolveVerificationCommands } = require('./lib/ecosystem.cjs');

const cwd = resolveWorkspaceCwd();
const rawLogFile = getArgValue('log_file');
const logFilePath = (rawLogFile && !rawLogFile.startsWith('$') && rawLogFile.trim() !== '' && rawLogFile !== 'undefined' && rawLogFile !== 'null') ? path.resolve(rawLogFile.trim()) : null;

let rawLogText = '';

if (logFilePath && fs.existsSync(logFilePath)) {
  rawLogText = fs.readFileSync(logFilePath, 'utf8');
} else {
  const commandsToRun = resolveVerificationCommands(cwd);

  for (const cmd of commandsToRun) {
    try {
      const out = execSync(cmd, { cwd, stdio: 'pipe', encoding: 'utf8' }).toString();
      rawLogText += `\n=== COMMAND: ${cmd} ===\n` + out;
    } catch (err) {
      const errOut = err.stdout ? err.stdout.toString() : '';
      const errErr = err.stderr ? err.stderr.toString() : '';
      const combined = (errOut + '\n' + errErr).trim() || err.message;
      rawLogText += `\n=== COMMAND FAILED: ${cmd} ===\n` + combined;
    }
  }
}

try {
  const roteTempDir = path.join(cwd, '.rote');
  fs.mkdirSync(roteTempDir, { recursive: true });
  fs.writeFileSync(path.join(roteTempDir, 'raw_captured_log.txt'), rawLogText);
} catch {}

process.stdout.write(JSON.stringify({
  status: 'CAPTURED',
  rawLogLength: rawLogText.length,
  logSnippet: rawLogText.slice(0, 500)
}));
