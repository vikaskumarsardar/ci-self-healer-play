# 🤖 Autonomous Universal CI/CD Self-Healing Healer (`ci-self-healer`)

> **Rote Play Playoffs Hackathon Submission**  
> **Published Registry URL**: [https://play.modiqo.ai/swapankumar/ci-self-healer](https://play.modiqo.ai/swapankumar/ci-self-healer)  
> **GitHub Repository**: [https://github.com/vikaskumarsardar/ci-self-healer-play](https://github.com/vikaskumarsardar/ci-self-healer-play)

---

## ⚡ Overview

`ci-self-healer` is an autonomous multi-language CI/CD failure diagnoser and self-healing repair play. It automatically scans project test suites and runners, captures error trace logs, synthesizes line-level code patches using LLMs (Gemini / OpenAI / Ollama), verifies test suites deterministically, and applies recovery fixes—all in under 10 seconds.

### 🌟 Key Capabilities
* **Multi-Ecosystem Support**: Auto-detects & heals Node.js (React & Express), Python (`unittest`/`pytest`), Go (`go test`), Ruby (`minitest`), and Rust (`cargo test`).
* **Keyless LLM Resolution**: Omits hardcoded credentials and inherits `process.env.GEMINI_API_KEY` or local AI proxies.
* **Recovery SLA Tracking**: Displays real-time diagnosis & repair elapsed timing (e.g. `Recovery SLA: 7.8s`).
* **IDE & MCP Native**: Bundles keyless `mcp.json` and `.agents/skills/ci-self-healer/SKILL.md` for seamless usage inside Cursor, Antigravity, and VS Code.

---

## 🚀 Quick Start & Usage

Run the published play on any repository directory:

```bash
rote play run https://play.modiqo.ai/swapankumar/ci-self-healer \
  target_dir="." \
  provider=gemini \
  model=gemini-3.7-flash \
  push_strategy=none \
  --yes
```

---

## ⚙️ Parameters

| Parameter | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `target_dir` | `string` | `.` | Target project directory containing test suite |
| `provider` | `string` | `gemini` | Cloud LLM Provider (`gemini`, `openai`, `ollama`) |
| `model` | `string` | `gemini-3.7-flash` | LLM model name |
| `push_strategy` | `string` | `none` | Delivery strategy (`direct`, `branch`, `pr`, `none`) |
| `auto_push` | `boolean` | `false` | Automatically commit & push verified fix to remote |

---

## 🏗️ Architecture Pipeline

```
  ┌─────────────────┐     ┌──────────────────┐     ┌─────────────────────┐     ┌──────────────────┐
  │ 1. Discover CI  │ ──► │ 2. Capture Logs  │ ──► │ 3. Synthesize Patch │ ──► │ 4. Verify Suite  │
  └─────────────────┘     └──────────────────┘     └─────────────────────┘     └──────────────────┘
   Detect Ecosystem        Parse Stack Traces       LLM Code Refactoring        Run Test Suite
   (Node/Py/Go/Ruby)       Extract Line Errors      Line-level Replacements     Recovery SLA Check
```

---

## 🛠️ MCP & IDE Integration

### Model Context Protocol (`mcp.json`)
```json
{
  "mcpServers": {
    "ci-self-healer": {
      "command": "rote",
      "args": [
        "play",
        "run",
        "https://play.modiqo.ai/swapankumar/ci-self-healer",
        "target_dir=${workspaceFolder}",
        "provider=gemini",
        "model=gemini-3.7-flash",
        "push_strategy=none",
        "--yes"
      ]
    }
  }
}
```

---

## 📜 License
MIT License © 2026 Swapan Kumar Sardar
