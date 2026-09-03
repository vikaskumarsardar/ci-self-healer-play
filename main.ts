#!/usr/bin/env -S rote play run
/**
 * Autonomous Universal Cloud LLM CI/CD Failure Diagnoser & Self-Healing Repair Play
 *
 * Scans host CI runners (npm, go, pytest, cargo, make), captures failure logs & stack traces,
 * queries GitHub Actions REST API & GitLab Pipelines REST API for cloud status,
 * synthesizes patch diagnostics using Cloud LLMs (Gemini, OpenAI, Ollama) with multi-attempt failure feedback loops,
 * executes autonomous self-healing repairs (INSTALL_DEPENDENCY, REFACTOR_CODE, SYNC_ENV_KEY, FIX_CONFIG),
 * and verifies test suites with deterministic multi-stage verification (lint, typecheck, build, test).
 *
 * @rote-frontmatter
 * ---
 * name: ci-self-healer
 * description: Autonomous Universal Cloud LLM CI/CD Failure Diagnoser & Self-Healing Repair Play for Node.js, Go, Python, Rust, and Make
 * provenance:
 *   author: swapankumar <swapankumarsardar73727@gmail.com>
 * metadata:
 *   version: 1.2.10
 *   status: released
 *   kind: atomic
 *   flow_type: sequential
 *   execution_model: steps_with_presentation
 *   format: typescript
 *   rote_version: 0.77.0
 *   requires_sessions: false
 *   requires_endpoints: []
 *   discoverability:
 *     tags:
 *     - ci-cd
 *     - test-healer
 *     - self-healing
 *     - ai-agent
 *     - gemini-llm
 *     - cloud-llm
 *     - auto-push
 *     - push-strategy
 *     - github-api
 *     - gitlab-api
 * parameters:
 * - name: auto_push
 *   param_type: boolean
 *   required: false
 *   description: Set to true to automatically commit and push verified self-healing patches back to Git remote
 * - name: push_strategy
 *   param_type: string
 *   required: false
 *   description: 'Git delivery strategy (direct: push to active branch, branch: create fix/ci-healer branch, pr: create branch & pull request, none: dry-run)'
 * - name: api_key
 *   param_type: string
 *   required: false
 *   description: Gemini / OpenAI Cloud LLM API Key for autonomous AI patch synthesis
 * - name: model
 *   param_type: string
 *   required: false
 *   description: Cloud LLM Model name (e.g. gemini-3.5-flash, gemini-flash-latest, gpt-4o-mini)
 * - name: provider
 *   param_type: string
 *   required: false
 *   description: Provider override (gemini, openai, ollama)
 * - name: base_url
 *   param_type: string
 *   required: false
 *   description: Custom OpenAI-compatible API base URL (e.g. http://localhost:11434/v1 for Ollama)
 * - name: github_token
 *   param_type: string
 *   required: false
 *   description: Optional GitHub Personal Access Token or GITHUB_TOKEN for GitHub Actions API access
 * - name: gitlab_token
 *   param_type: string
 *   required: false
 *   description: Optional GitLab Personal Access Token or GITLAB_TOKEN for GitLab Pipelines API access
 * - name: log_file
 *   param_type: string
 *   required: false
 *   description: Path to raw CI log file (defaults to live test execution stream)
 * - name: target_dir
 *   param_type: string
 *   required: false
 *   description: Target repository directory (defaults to current working directory)
 * steps:
 *   discover_ci:
 *     type: process.exec
 *     argv:
 *     - node
 *     - '@resource{discover_ci.js}'
 *     - target_dir=$target_dir
 *     - github_token=$github_token
 *     - gitlab_token=$gitlab_token
 *   capture_logs:
 *     type: process.exec
 *     depends_on:
 *     - discover_ci
 *     argv:
 *     - node
 *     - '@resource{capture_logs.js}'
 *     - target_dir=$target_dir
 *     - log_file=$log_file
 *   synthesize_patch:
 *     type: process.exec
 *     timeout_ms: 120000
 *     depends_on:
 *     - capture_logs
 *     argv:
 *     - node
 *     - '@resource{synthesize_patch.js}'
 *     - target_dir=$target_dir
 *     - log_file=$log_file
 *     - api_key=$api_key
 *     - model=$model
 *     - provider=$provider
 *     - base_url=$base_url
 *   verify_suite:
 *     type: process.exec
 *     timeout_ms: 120000
 *     depends_on:
 *     - synthesize_patch
 *     argv:
 *     - node
 *     - '@resource{verify_suite.js}'
 *     - target_dir=$target_dir
 *     - auto_push=$auto_push
 *     - push_strategy=$push_strategy
 *     - github_token=$github_token
 * ---
 */

const presentationSdk = await import("__ROTE_PRESENTATION_SDK__").catch((cause) => {
  throw new Error(
    "This is a rote steps presentation program. Run it with `rote play run <name>`.",
    { cause },
  );
});
const { FlowOutput, loadPresentationContext, stepName } = presentationSdk;

const out = new FlowOutput();
const ctx = await loadPresentationContext();

const renderedSteps: Record<string, unknown> = {};

function renderStep(step: ReturnType<typeof ctx.step>): unknown {
  switch (step.outcome.status) {
    case "completed":
    case "restored":
      return step.outcome.output.body;
    case "skipped":
      return { status: "skipped", reason: step.outcome.output.reason };
    case "failed":
      return { status: "failed", message: step.outcome.output.message };
    case "blocked":
      return {
        status: "blocked",
        reason: step.outcome.output.reason,
        blocked_by: step.outcome.output.blocked_by ?? [],
      };
    default:
      throw new Error(
        `unsupported step outcome: ${JSON.stringify(step.outcome)}. ` +
          `Re-export the play to regenerate this switch.`,
      );
  }
}

function parseBodyJson(body: unknown): any {
  if (!body) return null;
  let curr: any = body;
  for (let i = 0; i < 5; i++) {
    if (curr && typeof curr === "object") {
      if (curr.project || curr.engine || curr.status === "DISCOVERED" || curr.status === "CAPTURED" || curr.status === "VERIFIED" || curr.status === "DIAGNOSED") return curr;
      if (curr.stdout) curr = curr.stdout;
      else if (curr.body) curr = curr.body;
      else if (curr.text) curr = curr.text;
      else break;
    }
    if (typeof curr === "string") {
      try { curr = JSON.parse(curr.trim()); } catch { break; }
    }
  }
  return (curr && typeof curr === "object") ? curr : null;
}

const discoverCiStep = ctx.step(stepName("discover_ci"));
const captureLogsStep = ctx.step(stepName("capture_logs"));
const synthesizePatchStep = ctx.step(stepName("synthesize_patch"));
const verifySuiteStep = ctx.step(stepName("verify_suite"));

renderedSteps["discover_ci"] = renderStep(discoverCiStep);
renderedSteps["capture_logs"] = renderStep(captureLogsStep);
renderedSteps["synthesize_patch"] = renderStep(synthesizePatchStep);
renderedSteps["verify_suite"] = renderStep(verifySuiteStep);

// Safely parse step observations
const discoverData = discoverCiStep.outcome.status === "completed" ? parseBodyJson(discoverCiStep.outcome.output.body) : null;
const synthData = synthesizePatchStep.outcome.status === "completed" ? parseBodyJson(synthesizePatchStep.outcome.output.body) : null;
const verifyData = verifySuiteStep.outcome.status === "completed" ? parseBodyJson(verifySuiteStep.outcome.output.body) : null;

const projLang = discoverData?.project?.language || discoverData?.language || 'node';
const projRunner = discoverData?.project?.runner || discoverData?.runner || 'npm';
const engine = synthData?.engine || 'GEMINI_CLOUD_LLM';
const healedDetails = synthData?.healedActionDetails || synthData?.aiDiagnosis?.explanation || synthData?.errorReason || 'Self-healing patch applied and verified';

const statusVal =
  (typeof verifyData?.status === 'string'
    ? verifyData.status
    : verifyData?.status?.status) ||
  (verifySuiteStep.outcome.status === "completed"
    ? "VERIFIED"
    : verifySuiteStep.outcome.status.toUpperCase());

const commandsRunList = Array.isArray(verifyData?.commandsRun) && verifyData.commandsRun.length > 0
  ? verifyData.commandsRun.join(' ➔ ')
  : (typeof verifyData?.commandsRun === 'string' ? verifyData.commandsRun : 'npm run build ➔ npm test');

const branchVal = verifyData?.targetBranch || 'master';
const pushStrat = (verifyData?.pushStrategy || 'direct').toUpperCase();

const overallSuccess =
  verifySuiteStep.outcome.status === "completed" &&
  (verifyData?.testPassed === true || verifyData?.status === "VERIFIED" || statusVal === "VERIFIED");

const humanReport = `
${overallSuccess
  ? "⚡ Autonomous Universal CI/CD Self-Healing Healer Complete"
  : "⚠️ Autonomous Universal CI/CD Self-Healing Healer Stopped"}

📊 Pipeline Diagnostics Summary:
• Project Ecosystem  : ${projLang.toUpperCase()} (${projRunner})
• AI Healing Engine  : ${engine}
• Repaired Action    : ${healedDetails}
• Verification Suite : ${statusVal} (${commandsRunList})
• Git Delivery Mode  : ${pushStrat} (${branchVal})
`;

out.human(humanReport.trim());
out.summary(
  overallSuccess
    ? `CI Test Healer completed successfully: ${healedDetails}`
    : `CI Test Healer stopped: ${statusVal}`
);
out.result({
  run_id: ctx.run.run_id,
  steps: renderedSteps,
});
