const https = require('https');
const { execSync } = require('child_process');

function detectGitRemote(cwd) {
  let gitProvider = 'local';
  let repoOwner = null;
  let repoName = null;

  try {
    const remoteUrl = execSync('git remote get-url origin', { cwd, stdio: 'pipe' }).toString().trim();
    const ghMatch = remoteUrl.match(/github\.com[:\/]([^\/]+)\/([^\/\.]+)/);
    const glMatch = remoteUrl.match(/gitlab\.com[:\/]([^\/]+)\/([^\/\.]+)/);

    if (ghMatch) {
      gitProvider = 'github';
      repoOwner = ghMatch[1];
      repoName = ghMatch[2].replace(/\.git$/, '');
    } else if (glMatch) {
      gitProvider = 'gitlab';
      repoOwner = glMatch[1];
      repoName = glMatch[2].replace(/\.git$/, '');
    }
  } catch {
    // Local repo without remote
  }

  return { provider: gitProvider, owner: repoOwner, repo: repoName };
}

function fetchGithubApi(owner, repo, token) {
  return new Promise((resolve) => {
    if (!owner || !repo) return resolve(null);
    const headers = { 'User-Agent': 'Rote-CI-Test-Healer-Play' };
    if (token) headers['Authorization'] = `token ${token}`;

    const req = https.get({
      hostname: 'api.github.com',
      path: `/repos/${owner}/${repo}/actions/runs?per_page=1`,
      headers
    }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return resolve(null);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({
            provider: 'github',
            totalRuns: parsed.total_count || 0,
            latestStatus: parsed.workflow_runs?.[0]?.status || 'none',
            latestConclusion: parsed.workflow_runs?.[0]?.conclusion || 'none'
          });
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(2500, () => { req.destroy(); resolve(null); });
  });
}

function fetchGitlabApi(owner, repo, token) {
  return new Promise((resolve) => {
    if (!owner || !repo) return resolve(null);
    const projectPath = encodeURIComponent(`${owner}/${repo}`);
    const headers = { 'User-Agent': 'Rote-CI-Test-Healer-Play' };
    if (token) headers['PRIVATE-TOKEN'] = token;

    const req = https.get({
      hostname: 'gitlab.com',
      path: `/api/v4/projects/${projectPath}/pipelines?per_page=1`,
      headers
    }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return resolve(null);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({
            provider: 'gitlab',
            latestPipelineId: parsed[0]?.id || null,
            latestStatus: parsed[0]?.status || 'none'
          });
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(2500, () => { req.destroy(); resolve(null); });
  });
}

async function fetchCloudCiData(gitRemote, githubToken, gitlabToken) {
  if (gitRemote.provider === 'github') {
    return await fetchGithubApi(gitRemote.owner, gitRemote.repo, githubToken);
  } else if (gitRemote.provider === 'gitlab') {
    return await fetchGitlabApi(gitRemote.owner, gitRemote.repo, gitlabToken);
  }
  return null;
}

module.exports = {
  detectGitRemote,
  fetchGithubApi,
  fetchGitlabApi,
  fetchCloudCiData
};
