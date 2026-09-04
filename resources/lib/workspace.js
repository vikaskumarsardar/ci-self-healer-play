const fs = require('fs');
const path = require('path');

function getArgValue(name) {
  const arg = process.argv.find(a => a.startsWith(`${name}=`));
  return arg ? arg.slice(name.length + 1) : undefined;
}

function resolveWorkspaceCwd() {
  let hostDir = process.cwd();
  if (process.env.PWD && fs.existsSync(process.env.PWD) && !process.env.PWD.includes('.rote/workspaces')) {
    hostDir = process.env.PWD;
  } else if (process.env.INIT_CWD && fs.existsSync(process.env.INIT_CWD) && !process.env.INIT_CWD.includes('.rote/workspaces')) {
    hostDir = process.env.INIT_CWD;
  } else if (process.env.GITHUB_WORKSPACE && fs.existsSync(process.env.GITHUB_WORKSPACE)) {
    hostDir = process.env.GITHUB_WORKSPACE;
  }

  const rawTargetDir = getArgValue('target_dir');
  if (rawTargetDir && rawTargetDir.trim() !== '' && rawTargetDir !== 'undefined' && rawTargetDir !== 'null' && !rawTargetDir.startsWith('$')) {
    const target = rawTargetDir.trim();
    const abs = path.isAbsolute(target) ? target : path.resolve(hostDir, target);
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) return abs;
  }

  return path.resolve(hostDir);
}

function resolveProjectRoot(dir) {
  const target = path.resolve(dir || '.');
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) return target;
  return target;
}

module.exports = {
  getArgValue,
  resolveWorkspaceCwd,
  resolveProjectRoot
};
