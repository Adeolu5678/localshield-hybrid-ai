# LocalShield — HybridDoc Brief: Session Handoff

## Copy-Paste Prompt for New Session

```text
Read `Session Handoff.md`, `README.md`, `Submission Guide.md`, and `package.json` first.
Run `npx tsc --noEmit && npm test && npm run build && npm run build:extension` to verify the clean baseline.
Verify live Firebase App Check + Chrome Gemini Nano flows in the browser on `https://localshield.nuelbuilds.dev` (and `https://build-hybrid-ai.vercel.app`) after Emmanuel approves git push & Vercel deploy.
Do NOT commit, push, deploy, or submit on Devpost without Emmanuel's explicit approval.
```

## Challenge & Rules Snapshot

- **Hackathon:** `#BuildHybridAI 2026` (Google Firebase)
- **Devpost URL:** https://firebasehybridaihackathon.devpost.com/
- **Deadline:** `2026-11-30 22:00 UTC` (`2:00 PM PST`)
- **Prize Pool (`$30,000 USD` total):**
  - Grand Prize: `$10,000` (+ Firebase team interview, blog post, social feature)
  - 1st Runner-Up: `$7,000` | 2nd Runner-Up: `$4,000`
  - Platform Category Prizes: Best Web / Chrome App `$3,000`, Best Android App `$3,000`, Best iOS App `$3,000`
  - **Stackable Prizes:** Up to 1 overall/grand prize + 1 "Best of" category prize (up to `$13,000` for Web/Chrome).
- **Nigeria Eligibility:** Confirmed eligible.
- **OSS & Submission Requirements:** Public GitHub repo with root Apache-2.0 `LICENSE`, code importing and executing `firebase/ai` Hybrid Inference, live demo URL, and a `<= 3 min` public YouTube video demonstrating local-to-cloud fallback.
- **Hold Gate:** **Do NOT commit, push, deploy to Vercel, or submit on Devpost until Emmanuel reviews and explicitly approves.**

## Current Verified State (Post Milestone 4A)

- **TypeScript (`npx tsc --noEmit`):** Exit `0`
- **Offline Unit Tests (`npm test`):** `7` test files, `47` tests passed, exit `0`, zero outbound network calls:
  - `tests/piiRedactor.test.ts` (`9` tests)
  - `tests/documentIngestor.test.ts` (`3` tests)
  - `tests/scanHistory.test.ts` (`4` tests)
  - `tests/firebaseClient.test.ts` (`6` tests)
  - `tests/redlineDiff.test.ts` (`3` tests)
  - `tests/analysisParser.test.ts` (`3` tests)
  - `tests/hybridRouter.test.ts` (`19` tests)
- **Production Web/PWA Build (`npm run build`):** `390` modules transformed, `dist/` built cleanly (`index.html`, `pdf.worker.min`, `index.css`, `index.js`, `pdf.js`), exit `0`
- **Chrome Side-Panel Extension Build (`npm run build:extension`):** `46` modules transformed, `dist-extension/` built cleanly (`sidepanel.html`, `sidepanel.css`, `background.js`, `sidepanel.js`), exit `0`

## Live URLs, Repo & Auth State

- **GitHub Repo:** `https://github.com/Adeolu5678/localshield-hybrid-ai` (local workspace has Milestones 1–4A changes pending Emmanuel's review/push approval).
- **Vercel Project:** `build-hybrid-ai` (`prj_SoV7OsROD6P8FqyOSB3k4fZ6HoHn`)
  - `https://build-hybrid-ai.vercel.app`
  - `https://localshield.nuelbuilds.dev`
- **Firebase Project:** `localshield-hybrid-ai-5678` (`gemini-3-flash-preview`, App Check via `recaptcha-enterprise`).
- `.env` is gitignored; only `.env.example` is tracked.

## Architecture & Key Files

| Path | Role |
| :--- | :--- |
| `index.html`, `src/main.tsx`, `src/index.css` | Vite React 19 PWA entry, Google Fonts (`Inter` + `JetBrains Mono` with offline fallbacks), dark legal-privacy styling, print-PDF CSS |
| `src/App.tsx` | Full two-pane workbench, drag-and-drop local ingestion, custom terms, streaming preview, severity distribution bar & clause filters, history & negotiation drawers, Markdown/PDF export |
| `src/lib/piiRedactor.ts` | Stage 0 deterministic PII/secret vault (`12` regex/Luhn/custom categories) + vault restore + semantic PII merge |
| `src/lib/documentIngestor.ts` | Client-side `.pdf` (`pdfjs-dist` local worker), `.docx` (`mammoth`), `.txt`/`.md`, and multimodal image ingestion |
| `src/lib/firebaseClient.ts` | `firebase/ai` (`InferenceMode`, `Schema`), `GoogleAIBackend`, App Check (`ReCaptchaEnterpriseProvider` / `ReCaptchaV3Provider`) + 5s `getToken` timeout |
| `src/lib/hybridRouter.ts` | 4-stage pipeline: Stage 0 -> Stage 0.5 (`ONLY_ON_DEVICE` semantic PII) -> Stage 1 (`PREFER_ON_DEVICE` streaming + `countTokens()` chunking) -> Stage 2 (redacted cloud escalation + S1/S2 delta) + `401`/offline degradation + sandbox mode |
| `src/lib/analysisParser.ts` | Structured JSON/fence parser + deterministic heuristic analyzer fallback |
| `src/lib/redlineDiff.ts` | Word-level redline diffing & compiled redlined contract builder |
| `src/lib/scanHistory.ts` | IndexedDB local scan history (redacted-only persistence, zero raw PII written to disk) |
| `src/components/TelemetryBar.tsx` | Combined Stage 1 + Stage 2 latency/token telemetry with per-stage breakdown, live route badges, App Check status, and inline 30s Chrome Gemini Nano setup drawer + live Re-probe Nano |
| `src/components/HybridDeltaPanel.tsx` | Stage 1 vs. Stage 2 delta metrics and view switcher (`Merged`, `Stage 1`, `Stage 2`) |
| `src/components/ClauseCard.tsx` | Severity/category/delta card with Accept/Reject/Edit redline controls and Negotiate trigger |
| `src/components/ClauseNegotiationDrawer.tsx` | Per-clause multi-turn `startChat()` negotiation drawer with quick legal prompts and one-click Apply to Redline |
| `src/components/ContractDiffView.tsx` | Live compiled redlined contract diff view + toggleable browser-only Local PII Vault Restore |
| `src/components/LocalHistoryDrawer.tsx` | Offline IndexedDB scan history drawer (load, delete, clear) |
| `src/components/RedactionDiff.tsx` | Highlighted masked payload + token-to-original vault table + Stage 0.5 semantic PII strip |
| `public/manifest.webmanifest`, `public/sw.js`, `public/icons/*` | Installable offline-first PWA manifest, icons, and Service Worker |
| `extension/*`, `vite.extension.config.ts` | Manifest V3 Chrome Side-Panel Extension (`background.ts`, `SidePanelApp.tsx`, `sidepanel.html`) sharing `src/lib/*` |
| `tests/*.test.ts` | `7` offline Vitest suites (`47` tests) |

## Pre-Submit Checklist (Hold Gate Active)

- [ ] **Emmanuel Review & Approval:** Review local diff (`git status` / `git diff`) before any commit, push, or deploy.
- [ ] **Git Commit & Push:** Push Milestone 1–4A changes to `https://github.com/Adeolu5678/localshield-hybrid-ai` (confirm `.env` is NOT staged).
- [ ] **Vercel Production Deploy:** Deploy to `https://localshield.nuelbuilds.dev` and `https://build-hybrid-ai.vercel.app`, and verify live App Check token verification (zero `401` errors on both domains).
- [ ] **Chrome Extension Smoke Test:** Load unpacked `dist-extension/` in `chrome://extensions` and test one-click audit on a live Terms of Service page.
- [ ] **Offline PWA Smoke Test:** Open deployed URL in Chrome, verify `Offline Shell Ready`, toggle DevTools Offline, reload, and run `ONLY_ON_DEVICE` analysis.
- [ ] **Record <= 3-Min YouTube Video:** Follow the timestamped script in `Submission Guide.md` (0:00–2:55).
- [ ] **Devpost Submission (Only After Emmanuel Approves):** Submit under **Web / Chrome** before `2026-11-30 22:00 UTC`.

## Local Verification Commands

```powershell
npx tsc --noEmit
npm test
npm run build
npm run build:extension
npm run dev
```
