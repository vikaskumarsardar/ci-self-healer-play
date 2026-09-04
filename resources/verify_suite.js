const fs = require('fs');
const path = require('path');
const { execFileSync, execSync } = require('child_process');

function getArgValue(name) {
  const arg = process.argv.find(a => a.startsWith(`${name}=`));
  return arg ? arg.slice(name.length + 1) : undefined;
}

function resolveWorkspaceCwd() {
  const rawTargetDir = getArgValue('target_dir');
  if (rawTargetDir && path.isAbsolute(rawTargetDir.trim()) && fs.existsSync(rawTargetDir.trim())) {
    return path.resolve(rawTargetDir.trim());
  }

  let baseDir = process.cwd();
  if (process.env.GITHUB_WORKSPACE && fs.existsSync(process.env.GITHUB_WORKSPACE)) {
    baseDir = process.env.GITHUB_WORKSPACE;
  } else if (process.env.PWD && fs.existsSync(process.env.PWD) && !process.env.PWD.includes('.rote/workspaces')) {
    baseDir = process.env.PWD;
  } else if (process.env.INIT_CWD && fs.existsSync(process.env.INIT_CWD) && !process.env.INIT_CWD.includes('.rote/workspaces')) {
    baseDir = process.env.INIT_CWD;
  }

  if (rawTargetDir && rawTargetDir.trim() !== '' && rawTargetDir !== 'undefined' && rawTargetDir !== 'null') {
    const target = rawTargetDir.trim();
    const abs = path.isAbsolute(target) ? target : path.resolve(baseDir, target);
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) return abs;
  }

  return path.resolve(baseDir);
}

const cwd = resolveWorkspaceCwd();

const rawAutoPush = getArgValue('auto_push');
const autoPush = rawAutoPush === 'true' || process.env.AUTO_PUSH === 'true';

const rawPushStrategy = getArgValue('push_strategy');
const pushStrategyArg = (rawPushStrategy && !rawPushStrategy.startsWith('$') && rawPushStrategy !== 'undefined') ? rawPushStrategy.trim().toLowerCase() : null;

// Strategies: direct (push to current branch), branch (create fix/ci-healer-XXXX branch), pr (branch + open PR), none
let pushStrategy = pushStrategyArg || process.env.PUSH_STRATEGY || (autoPush ? 'direct' : 'none');
if (pushStrategy !== 'direct' && pushStrategy !== 'branch' && pushStrategy !== 'pr' && pushStrategy !== 'none') {
  pushStrategy = 'none';
}

function resolveProjectRoot(dir) {
  const target = path.resolve(dir || '.');
  const manifests = ['package.json', 'go.mod', 'requirements.txt', 'pytest.ini', 'pyproject.toml', 'Cargo.toml', 'Gemfile', 'Rakefile'];
  if (fs.existsSync(target)) {
    const files = fs.readdirSync(target);
    if (manifests.some(m => files.includes(m))) return target;
  }
  if (fs.existsSync(process.cwd())) {
    const procFiles = fs.readdirSync(process.cwd());
    if (manifests.some(m => procFiles.includes(m))) return process.cwd();
  }
  return target;
}

const resolvedCwd = resolveProjectRoot(cwd);
const files = fs.existsSync(resolvedCwd) ? fs.readdirSync(resolvedCwd) : [];
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
} else if (files.includes('requirements.txt') || files.includes('pytest.ini') || files.includes('pyproject.toml') || files.includes('setup.py') || files.includes('Pipfile') || files.includes('tox.ini') || files.some(f => f.endsWith('.py'))) {
  commandsToRun.push('python3 -m unittest 2>/dev/null || pytest');
} else if (files.includes('Cargo.toml')) {
  commandsToRun.push('cargo test');
} else if (files.includes('Gemfile') || files.includes('Rakefile') || files.some(f => f.endsWith('.rb'))) {
  commandsToRun.push('ruby -e "Dir.glob(\'./**/*_test.rb\').each { |f| require f }"');
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
    
    // 🛡️ Stage project changes safely (excluding temporary artifacts & build directories)
    execFileSync('git', ['add', '.', ':(exclude).rote', ':(exclude)node_modules', ':(exclude)dist', ':(exclude)build', ':(exclude)target', ':(exclude)__pycache__'], { cwd });

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
