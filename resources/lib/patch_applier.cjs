const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function isSafePath(cwd, targetPath) {
  if (!targetPath) return false;
  const resolved = path.resolve(cwd, targetPath);
  const relative = path.relative(cwd, resolved);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

function sanitizePackageName(pkg) {
  if (!pkg) return null;
  const trimmed = pkg.trim();
  if (/^[a-zA-Z0-9_\-\/@\.]+$/.test(trimmed)) {
    return trimmed;
  }
  return null;
}

class PatchManager {
  constructor(cwd) {
    this.cwd = cwd;
    this.fileBackups = new Map();
  }

  backupFile(filePath) {
    if (!this.fileBackups.has(filePath)) {
      this.fileBackups.set(filePath, fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null);
    }
  }

  revertBackups() {
    for (const [filePath, content] of this.fileBackups.entries()) {
      if (content === null) {
        if (fs.existsSync(filePath)) { try { fs.unlinkSync(filePath); } catch {} }
      } else {
        try { fs.writeFileSync(filePath, content); } catch {}
      }
    }
  }

  applySingleAction(actionObj) {
    const actionNorm = (actionObj.action || '').toUpperCase().trim();

    if (actionNorm === 'INSTALL_DEPENDENCY') {
      const sanitizedPkg = sanitizePackageName(actionObj.target);
      if (!sanitizedPkg) return { applied: false, error: `Invalid package: ${actionObj.target}` };

      try {
        if (fs.existsSync(path.join(this.cwd, 'package.json'))) {
          execFileSync('npm', ['install', '--legacy-peer-deps', sanitizedPkg], { cwd: this.cwd, stdio: 'pipe' });
          return { applied: true };
        } else if (fs.existsSync(path.join(this.cwd, 'go.mod'))) {
          execFileSync('go', ['get', sanitizedPkg], { cwd: this.cwd, stdio: 'pipe' });
          return { applied: true };
        } else if (fs.existsSync(path.join(this.cwd, 'requirements.txt'))) {
          execFileSync('pip', ['install', sanitizedPkg], { cwd: this.cwd, stdio: 'pipe' });
          return { applied: true };
        } else if (fs.existsSync(path.join(this.cwd, 'Cargo.toml'))) {
          execFileSync('cargo', ['add', sanitizedPkg], { cwd: this.cwd, stdio: 'pipe' });
          return { applied: true };
        }
      } catch (err) {
        return { applied: false, error: err.message };
      }
      return { applied: false, error: 'No matching package manager found' };
    }

    if (actionNorm === 'REFACTOR_CODE' || actionNorm === 'FIX_CONFIG') {
      const fileTarget = (actionObj.target || '').trim();
      if (!fileTarget) {
        return { applied: false, error: 'Missing target file path in diagnosis action' };
      }
      if (!isSafePath(this.cwd, fileTarget)) {
        return { applied: false, error: `Path traversal security violation: ${fileTarget}` };
      }

      const fileToPatch = path.resolve(this.cwd, fileTarget);
      this.backupFile(fileToPatch);

      if (fs.existsSync(fileToPatch)) {
        if (Array.isArray(actionObj.lineEdits) && actionObj.lineEdits.length > 0 && actionObj.lineEdits.length <= 20) {
          let lines = fs.readFileSync(fileToPatch, 'utf8').split('\n');
          const sanitizedEdits = actionObj.lineEdits.map(e => ({
            startLine: Math.max(1, Math.min(lines.length, e.startLine)),
            endLine: Math.max(1, Math.min(lines.length, e.endLine)),
            replacement: e.replacement
          }));
          const invalidEdits = sanitizedEdits.some(e =>
            !Number.isInteger(e.startLine) ||
            !Number.isInteger(e.endLine) ||
            typeof e.replacement !== 'string' ||
            e.endLine < e.startLine
          );

          if (!invalidEdits) {
            const uniqueEditsMap = new Map();
            for (const edit of sanitizedEdits) {
              uniqueEditsMap.set(`${edit.startLine}:${edit.endLine}`, edit);
            }
            const sortedEdits = Array.from(uniqueEditsMap.values()).sort((a, b) => b.startLine - a.startLine);
            let hasOverlap = false;
            let lastStart = Infinity;
            for (const edit of sortedEdits) {
              if (edit.endLine >= lastStart) { hasOverlap = true; break; }
              lastStart = edit.startLine;
            }

            if (!hasOverlap) {
              for (const edit of sortedEdits) {
                const start = Math.max(0, edit.startLine - 1);
                const end = Math.min(lines.length, edit.endLine);
                lines.splice(start, end - start, edit.replacement);
              }
              fs.writeFileSync(fileToPatch, lines.join('\n'));
              return { applied: true };
            }
          }
        }

        if (actionObj.replacementCode && typeof actionObj.replacementCode === 'string' && actionObj.replacementCode.trim().length > 10) {
          const origContent = fs.readFileSync(fileToPatch, 'utf8');
          const origLineCount = origContent.split('\n').length;
          const newContent = actionObj.replacementCode.trim();
          const newLineCount = newContent.split('\n').length;
          if (origLineCount > 8 && newLineCount < origLineCount * 0.75) {
            return { applied: false, error: `Destructive replacement rejected: LLM attempted to reduce file from ${origLineCount} lines to ${newLineCount} lines. Surgical lineEdits required to preserve UI and logic.` };
          }
          fs.writeFileSync(fileToPatch, newContent);
          return { applied: true };
        }
        return { applied: false, error: `No valid lineEdits provided for existing file ${fileTarget}` };
      } else if (actionObj.replacementCode) {
        fs.mkdirSync(path.dirname(fileToPatch), { recursive: true });
        fs.writeFileSync(fileToPatch, actionObj.replacementCode);
        return { applied: true };
      }
      return { applied: false, error: `Target file not found: ${fileTarget}` };
    }

    return { applied: false, error: `Unsupported action: ${actionNorm}` };
  }

  applyPatch(aiDiagnosis) {
    if (!aiDiagnosis) return { applied: false, error: 'No diagnosis provided' };
    const actions = (Array.isArray(aiDiagnosis.actions) && aiDiagnosis.actions.length > 0)
      ? aiDiagnosis.actions
      : [aiDiagnosis];

    if (actions.length === 0 || !actions.some(a => a && a.target)) {
      return { applied: false, error: 'No valid patch actions returned by LLM' };
    }

    for (const act of actions) {
      if (!act || !act.target) continue;
      const res = this.applySingleAction(act);
      if (!res.applied) {
        return res;
      }
    }
    return { applied: true };
  }
}

module.exports = {
  isSafePath,
  sanitizePackageName,
  PatchManager
};
