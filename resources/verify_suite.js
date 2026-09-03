const fs = require('fs');
const path = require('path');
const { execFileSync, execSync } = require('child_process');

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

const rawAutoPush = getArgValue('auto_push');
const autoPush = rawAutoPush === 'true' || process.env.AUTO_PUSH === 'true';

const rawPushStrategy = getArgValue('push_strategy');
const pushStrategyArg = (rawPushStrategy && !rawPushStrategy.startsWith('$') && rawPushStrategy !== 'undefined') ? rawPushStrategy.trim().toLowerCase() : null;

// Strategies: direct (push to current branch), branch (create fix/ci-healer-XXXX branch), pr (branch + open PR), none
let pushStrategy = pushStrategyArg || process.env.PUSH_STRATEGY || (autoPush ? 'direct' : 'none');
if (pushStrategy !== 'direct' && pushStrategy !== 'branch' && pushStrategy !== 'pr' && pushStrategy !== 'none') {
  pushStrategy = 'direct';
}

const files = fs.existsSync(cwd) ? fs.readdirSync(cwd) : [];
const commandsToRun = [];

if (files.includes('package.json')) {
  try {
    const pkgJson = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
    if (pkgJson.scripts?.lint) commandsToRun.push('npm run lint');
    if (pkgJson.scripts?.typecheck) commandsToRun.push('npm run typecheck');
    if (pkgJson.scripts?.build) commandsToRun.push('npm run build');
    if (pkgJson.scripts?.test) commandsToRun.push('npm test');
  } catch {
    commandsToRun.push('npm test');
  }
} else if (files.includes('go.mod') || files.some(f => f.endsWith('.go'))) {
  commandsToRun.push('go test ./...');
} else if (files.includes('requirements.txt') || files.includes('pytest.ini') || files.includes('pyproject.toml') || files.includes('setup.py') || files.includes('Pipfile') || files.includes('tox.ini')) {
  commandsToRun.push('pytest');
} else if (files.includes('Cargo.toml')) {
  commandsToRun.push('cargo test');
}

// 🛡️ Security & Integrity Guard: Fail if no supported verification command was detected
if (commandsToRun.length === 0) {
  process.stdout.write(JSON.stringify({
    status: 'NO_VERIFICATION',
    testPassed: false,
    reason: 'No supported verification commands detected in target directory',
    commandsRun: [],
    cwd
  }));
  process.exit(2);
}

let testPassed = true;
let failedCommand = null;
let testErrorOutput = '';
const executedCommands = [];

for (const cmd of commandsToRun) {
  executedCommands.push(cmd);
  try {
    execSync(cmd, { cwd, stdio: 'pipe' });
  } catch (err) {
    testPassed = false;
    failedCommand = cmd;
    const errOut = err.stdout ? err.stdout.toString() : '';
    const errErr = err.stderr ? err.stderr.toString() : '';
    testErrorOutput = (errOut + '\n' + errErr).trim() || err.message;
    break;
  }
}

let pushedRemote = false;
let pushError = null;
let targetBranch = null;

const rawGithubToken = getArgValue('github_token');
const githubToken = (rawGithubToken && !rawGithubToken.startsWith('$') && rawGithubToken !== 'undefined' && rawGithubToken !== 'null')
  ? rawGithubToken.trim()
  : (process.env.GITHUB_TOKEN || null);

if (testPassed && pushStrategy !== 'none') {
  try {
    execFileSync('git', ['config', 'user.name', 'Rote-CI-Healer-Bot'], { cwd });
    execFileSync('git', ['config', 'user.email', 'ci-healer@modiqo.ai'], { cwd });

    if (githubToken && process.env.GITHUB_REPOSITORY) {
      try {
        execFileSync('git', ['remote', 'set-url', 'origin', `https://x-access-token:${githubToken}@github.com/${process.env.GITHUB_REPOSITORY}.git`], { cwd });
      } catch { /* Fallback */ }
    }
    
    // 🛡️ Stage project changes while strictly excluding build artifacts and node_modules
    execFileSync('git', ['add', '.', ':!.rote', ':!node_modules', ':!dist', ':!build', ':!target', ':!__pycache__'], { cwd });

    // Safely check current branch
    let originalBranch = 'master';
    try {
      const b = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd }).toString().trim();
      if (b && b !== 'HEAD') originalBranch = b;
    } catch { /* Fallback */ }

    targetBranch = originalBranch;

    // Handle branch creation if strategy is branch or pr
    if (pushStrategy === 'branch' || pushStrategy === 'pr') {
      const fixBranch = `fix/ci-healer-${Date.now().toString().slice(-4)}`;
      try {
        execFileSync('git', ['checkout', '-b', fixBranch], { cwd });
        targetBranch = fixBranch;
      } catch { /* Fallback to current branch */ }
    }

    // Commit and push safely via execFileSync
    try {
      execFileSync('git', ['commit', '-m', 'fix(ci-healer): autonomous self-healing patch'], { cwd });
    } catch { /* Handle empty commit cleanly */ }

    const pushSpec = `HEAD:refs/heads/${targetBranch}`;
    execFileSync('git', ['push', 'origin', pushSpec], { cwd });
    pushedRemote = true;
  } catch (err) {
    pushError = err.message;
  }
}

if (!testPassed) {
  process.stderr.write(JSON.stringify({
    status: 'VERIFICATION_FAILED',
    testPassed: false,
    failedCommand,
    errorOutput: testErrorOutput,
    commandsRun: executedCommands,
    cwd
  }));
  process.exit(1);
} else {
  process.stdout.write(JSON.stringify({
    status: 'VERIFIED',
    testPassed: true,
    commandsRun: executedCommands,
    autoPushed: pushedRemote,
    pushStrategy,
    targetBranch,
    pushError,
    cwd
  }));
}
