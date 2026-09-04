const fs = require('fs');
const path = require('path');
const { getArgValue, resolveWorkspaceCwd } = require('./lib/workspace');
const { detectEcosystem } = require('./lib/ecosystem');
const { detectGitRemote, fetchCloudCiData } = require('./lib/cloud_ci');

const cwd = resolveWorkspaceCwd();
const githubToken = getArgValue('github_token') || process.env.GITHUB_TOKEN;
const gitlabToken = getArgValue('gitlab_token') || process.env.GITLAB_TOKEN;

const ecosystem = detectEcosystem(cwd);
const gitRemote = detectGitRemote(cwd);

const files = fs.existsSync(cwd) ? fs.readdirSync(cwd) : [];
const githubWorkflowDir = path.join(cwd, '.github', 'workflows');
const hasGithubActions = fs.existsSync(githubWorkflowDir) && fs.readdirSync(githubWorkflowDir).some(f => f.endsWith('.yml') || f.endsWith('.yaml'));
const hasGitlabCi = files.includes('.gitlab-ci.yml');
const hasDocker = files.includes('Dockerfile') || files.includes('docker-compose.yml');

async function main() {
  const cloudCiData = await fetchCloudCiData(gitRemote, githubToken, gitlabToken);

  process.stdout.write(JSON.stringify({
    status: 'DISCOVERED',
    cwd,
    project: ecosystem,
    ciPipelines: {
      githubActions: hasGithubActions,
      gitlabCi: hasGitlabCi,
      docker: hasDocker
    },
    remoteProvider: {
      provider: gitRemote.provider,
      owner: gitRemote.owner,
      repo: gitRemote.repo,
      cloudCiData
    }
  }));
}

main();
