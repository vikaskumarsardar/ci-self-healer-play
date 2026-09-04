const { execSync } = require('child_process');

function executeGitDelivery(cwd, pushStrategy, autoPush, githubToken) {
  let targetBranch = 'master';
  let pushError = null;

  try {
    targetBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd, stdio: 'pipe' }).toString().trim();
  } catch {}

  const shouldPush = (pushStrategy !== 'none') && (autoPush || pushStrategy === 'direct' || pushStrategy === 'branch' || pushStrategy === 'pr');

  if (shouldPush) {
    try {
      execSync('git add -A', { cwd, stdio: 'pipe' });
      
      let hasChanges = false;
      try {
        execSync('git diff --cached --quiet', { cwd, stdio: 'pipe' });
      } catch {
        hasChanges = true;
      }

      if (hasChanges) {
        execSync('git commit -m "fix(ci-healer): autonomous universal self-healing patch applied"', { cwd, stdio: 'pipe' });
      }

      if (pushStrategy === 'branch' || pushStrategy === 'pr') {
        const fixBranch = `fix/ci-healer-${Date.now().toString().slice(-6)}`;
        execSync(`git checkout -b ${fixBranch}`, { cwd, stdio: 'pipe' });
        targetBranch = fixBranch;
      }

      execSync(`git push origin ${targetBranch}`, { cwd, stdio: 'pipe' });
    } catch (err) {
      pushError = err.message.slice(0, 150);
    }
  }

  return {
    pushStrategy: pushStrategy.toUpperCase(),
    targetBranch,
    pushed: shouldPush && !pushError,
    pushError
  };
}

module.exports = {
  executeGitDelivery
};
