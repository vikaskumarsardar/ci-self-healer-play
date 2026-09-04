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

  applyPatch(aiDiagnosis) {
    const actionNorm = (aiDiagnosis.action || '').toUpperCase().trim();

    if (actionNorm === 'INSTALL_DEPENDENCY') {
      const sanitizedPkg = sanitizePackageName(aiDiagnosis.target);
      if (!sanitizedPkg) return { applied: false, error: `Invalid package: ${aiDiagnosis.target}` };

      try {
        if (fs.existsSync(path.join(this.cwd, 'package.json'))) {
          execFileSync('npm', ['install', sanitizedPkg], { cwd: this.cwd, stdio: 'pipe' });
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
      const fileTarget = (aiDiagnosis.target || '').trim();
      if (!isSafePath(this.cwd, fileTarget)) {
        return { applied: false, error: `Path traversal security violation: ${fileTarget}` };
      }

      const fileToPatch = path.resolve(this.cwd, fileTarget);
      this.backupFile(fileToPatch);

      if (fs.existsSync(fileToPatch)) {
        if (Array.isArray(aiDiagnosis.lineEdits) && aiDiagnosis.lineEdits.length > 0 && aiDiagnosis.lineEdits.length <= 20) {
          let lines = fs.readFileSync(fileToPatch, 'utf8').split('\n');
          const invalidEdits = aiDiagnosis.lineEdits.some(e =>
            !Number.isInteger(e.startLine) ||
            !Number.isInteger(e.endLine) ||
            typeof e.replacement !== 'string' ||
            e.startLine > lines.length ||
            e.endLine > lines.length ||
            e.startLine < 1 ||
            e.endLine < e.startLine
          );

          if (!invalidEdits) {
            const uniqueEditsMap = new Map();
            for (const edit of aiDiagnosis.lineEdits) {
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

        if (aiDiagnosis.replacementCode && typeof aiDiagnosis.replacementCode === 'string' && aiDiagnosis.replacementCode.trim().length > 10) {
          fs.writeFileSync(fileToPatch, aiDiagnosis.replacementCode.trim());
          return { applied: true };
        }
        return { applied: false, error: `No valid lineEdits or replacementCode for ${fileTarget}` };
      } else if (aiDiagnosis.replacementCode) {
        fs.mkdirSync(path.dirname(fileToPatch), { recursive: true });
        fs.writeFileSync(fileToPatch, aiDiagnosis.replacementCode);
        return { applied: true };
      }
      return { applied: false, error: `Target file not found: ${fileTarget}` };
    }

    return { applied: false, error: `Unsupported action: ${actionNorm}` };
  }
}

module.exports = {
  isSafePath,
  sanitizePackageName,
  PatchManager
};
