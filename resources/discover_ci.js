const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

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

const rawGithubToken = getArgValue('github_token');
const githubToken = rawGithubToken || process.env.GITHUB_TOKEN;

const rawGitlabToken = getArgValue('gitlab_token');
const gitlabToken = rawGitlabToken || process.env.GITLAB_TOKEN;

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

// 1. Rich Project & Test Runner Metadata Discovery
let language = 'unknown';
let runner = 'unknown';
let testCommand = '';
let packageScripts = {};

if (files.includes('package.json')) {
  language = 'node';
  runner = 'npm';
  testCommand = 'npm test';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
    packageScripts = pkg.scripts || {};
  } catch { /* Fallback */ }
} else if (files.includes('go.mod') || files.some(f => f.endsWith('.go'))) {
  language = 'go';
  runner = 'go';
  testCommand = 'go test ./...';
} else if (files.includes('requirements.txt') || files.includes('pytest.ini') || files.includes('pyproject.toml') || files.includes('setup.py') || files.includes('Pipfile') || files.includes('tox.ini') || files.some(f => f.endsWith('.py'))) {
  language = 'python';
  runner = 'python3';
  testCommand = 'python3 -m unittest discover 2>/dev/null || pytest';
} else if (files.includes('Cargo.toml')) {
  language = 'rust';
  runner = 'cargo';
  testCommand = 'cargo test';
} else if (files.includes('Gemfile') || files.includes('Rakefile') || files.some(f => f.endsWith('.rb'))) {
  language = 'ruby';
  runner = 'ruby';
  testCommand = 'ruby -e "Dir.glob(\'./**/*_test.rb\').each { |f| require f }"';
} else if (files.includes('Makefile')) {
  language = 'make';
  runner = 'make';
  testCommand = 'make test';
}

// 2. Detect CI Pipeline Configs (Validates actual .yml / .yaml workflow files)
const githubWorkflowDir = path.join(cwd, '.github', 'workflows');
const hasGithubActions = fs.existsSync(githubWorkflowDir) && fs.readdirSync(githubWorkflowDir).some(f => f.endsWith('.yml') || f.endsWith('.yaml'));
const hasGitlabCi = files.includes('.gitlab-ci.yml');
const hasDocker = files.includes('Dockerfile') || files.includes('docker-compose.yml');

// 3. Detect Git Remote Provider (GitHub vs GitLab)
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

// 4. HTTP API Call for GitHub Actions API (With HTTP status code validation)
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

// 5. HTTP API Call for GitLab Pipelines API (With HTTP status code validation)
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

async function main() {
  let cloudCiData = null;
  if (gitProvider === 'github') {
    cloudCiData = await fetchGithubApi(repoOwner, repoName, githubToken);
  } else if (gitProvider === 'gitlab') {
    cloudCiData = await fetchGitlabApi(repoOwner, repoName, gitlabToken);
  }

  process.stdout.write(JSON.stringify({
    status: 'DISCOVERED',
    cwd,
    project: {
      language,
      runner,
      testCommand,
      scripts: packageScripts
    },
    ciPipelines: {
      githubActions: hasGithubActions,
      gitlabCi: hasGitlabCi,
      docker: hasDocker
    },
    remoteProvider: {
      provider: gitProvider,
      owner: repoOwner,
      repo: repoName,
      cloudCiData
    }
  }));
}

main();
