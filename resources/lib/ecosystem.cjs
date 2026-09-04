const fs = require('fs');
const path = require('path');

function detectEcosystem(cwd) {
  const files = fs.existsSync(cwd) ? fs.readdirSync(cwd) : [];
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
    } catch {}
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

  return { language, runner, testCommand, scripts: packageScripts };
}

function resolveVerificationCommands(cwd) {
  const files = fs.existsSync(cwd) ? fs.readdirSync(cwd) : [];
  const commandsToRun = [];

  if (files.includes('package.json')) {
    try {
      const pkgJson = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
      if (pkgJson.scripts?.lint) commandsToRun.push('npm run lint');
      if (pkgJson.scripts?.typecheck) commandsToRun.push('npm run typecheck');
      if (pkgJson.scripts?.build) commandsToRun.push('npm run build');
      if (pkgJson.scripts?.test && !pkgJson.scripts.test.includes('no test specified')) {
        commandsToRun.push('npm test');
      }
    } catch {
      commandsToRun.push('npm test');
    }

    if (commandsToRun.length === 0) {
      const hasTestFile = files.some(f => f.includes('test') || f.includes('spec'));
      if (hasTestFile) {
        commandsToRun.push('node --test 2>/dev/null || node test.cjs');
      } else {
        commandsToRun.push('node -c index.js 2>/dev/null || node -c src/index.js 2>/dev/null || true');
      }
    }
  } else if (files.includes('go.mod') || files.some(f => f.endsWith('.go'))) {
    commandsToRun.push('go test ./...');
  } else if (files.includes('requirements.txt') || files.includes('pytest.ini') || files.includes('pyproject.toml') || files.includes('setup.py') || files.includes('Pipfile') || files.includes('tox.ini') || files.some(f => f.endsWith('.py'))) {
    commandsToRun.push('python3 -m unittest discover 2>&1 || pytest');
  } else if (files.includes('Cargo.toml')) {
    commandsToRun.push('cargo test');
  } else if (files.includes('Gemfile') || files.includes('Rakefile') || files.some(f => f.endsWith('.rb'))) {
    commandsToRun.push('ruby -e "Dir.glob(\'./**/*_test.rb\').each { |f| require f }"');
  } else if (files.includes('Makefile')) {
    commandsToRun.push('make test');
  }

  return commandsToRun;
}

module.exports = {
  detectEcosystem,
  resolveVerificationCommands
};
