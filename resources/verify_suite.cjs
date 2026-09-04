const { execSync } = require('child_process');
const { getArgValue, resolveWorkspaceCwd } = require('./lib/workspace.cjs');
const { resolveVerificationCommands } = require('./lib/ecosystem.cjs');
const { executeGitDelivery } = require('./lib/git_delivery.cjs');

const cwd = resolveWorkspaceCwd();

const rawAutoPush = getArgValue('auto_push');
const autoPush = rawAutoPush === 'true' || process.env.AUTO_PUSH === 'true';

const rawPushStrategy = getArgValue('push_strategy');
const pushStrategyArg = (rawPushStrategy && !rawPushStrategy.startsWith('$') && rawPushStrategy !== 'undefined') ? rawPushStrategy.trim().toLowerCase() : null;

let pushStrategy = pushStrategyArg || process.env.PUSH_STRATEGY || (autoPush ? 'direct' : 'none');
if (pushStrategy !== 'direct' && pushStrategy !== 'branch' && pushStrategy !== 'pr' && pushStrategy !== 'none') {
  pushStrategy = 'none';
}

const rawGithubToken = getArgValue('github_token');
const githubToken = rawGithubToken || process.env.GITHUB_TOKEN;

const commandsToRun = resolveVerificationCommands(cwd);

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

for (const cmd of commandsToRun) {
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

if (!testPassed) {
  process.stdout.write(JSON.stringify({
    status: 'VERIFICATION_FAILED',
    testPassed: false,
    failedCommand,
    errorOutput: testErrorOutput,
    commandsRun: commandsToRun,
    cwd
  }));
  process.exit(1);
}

const deliveryRes = executeGitDelivery(cwd, pushStrategy, autoPush, githubToken);

process.stdout.write(JSON.stringify({
  status: 'VERIFIED',
  testPassed: true,
  commandsRun: commandsToRun,
  pushStrategy: deliveryRes.pushStrategy,
  targetBranch: deliveryRes.targetBranch,
  pushed: deliveryRes.pushed,
  pushError: deliveryRes.pushError,
  cwd
}));
