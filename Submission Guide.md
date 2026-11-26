# LocalShield — HybridDoc Brief: Devpost Submission Guide

## 1. Devpost Submission Writeup

### Project Name
**LocalShield — HybridDoc Brief**

### Tagline
Offline-first, zero-leakage contract and privacy-policy risk analyzer powered by Firebase AI Logic hybrid inference (`PREFER_ON_DEVICE` & `ONLY_ON_DEVICE`), Chrome Gemini Nano, and Firebase App Check — delivered as an installable Web PWA and Chrome Side-Panel Extension.

### Inspiration
Founders, security engineers, and legal reviewers paste confidential contracts, DPAs, and API terms into cloud chatbots every day—often leaking SSNs, EINs, customer emails, Luhn-valid payment cards, IBANs, JWTs, AWS keys, and live API secrets (`sk-live-...`) in the prompt payload. On-device models like Chrome's Gemini Nano keep sensitive documents strictly local, while cloud Gemini excels at deep cross-clause synthesis and negotiation. We built LocalShield to combine both cleanly through **Firebase AI Logic's hybrid inference SDK**.

### What It Does
1. **Stage 0 — Deterministic Local PII Vault (0 bytes leave browser):** Masks `API_SECRET`, `AWS_KEY`, `JWT`, `SSN`, `EIN`, Luhn-validated `CARD`, `IBAN`, `EMAIL`, `PHONE`, `IPV4`, `ADDRESS`, and user-defined **Custom Confidential Terms** in-browser before any prompt is constructed.
2. **Stage 0.5 — Optional On-Device Semantic PII Scrub (`ONLY_ON_DEVICE`):** Runs strictly on-device via Chrome Gemini Nano to mask unstructured `PERSON`, `ORG`, and `CODENAME` entities locally without cloud egress.
3. **Stage 1 — On-Device First Triage (`PREFER_ON_DEVICE`):** Uses `getGenerativeModel(ai, { mode: InferenceMode.PREFER_ON_DEVICE })` with `generateContentStream()`, `AbortController` cancel, and `countTokens()` chunking to extract risky clauses, severity distribution, and copyable redline proposals—running on Chrome Gemini Nano when available and falling back seamlessly to Cloud Gemini (`gemini-3-flash-preview`) or our local heuristic analyzer.
4. **Stage 2 — App Check-Guarded Cloud Escalation & Clause Negotiation (PII-Redacted Only):** When online and not in `ONLY_ON_DEVICE` air-gap mode, sends only the PII-redacted text to Cloud Gemini via `GoogleAIBackend` (protected by Firebase App Check) for cross-clause contradiction synthesis, a **Stage 1 vs. Stage 2 Delta** comparison panel, and per-clause `startChat()` negotiation.
5. **Local PDF/DOCX/Image Ingestion + Redline Diff + Local Vault Restore:** Parses `.pdf` (local PDF.js worker), `.docx` (Mammoth), and scanned images client-side; lets users Accept/Reject/Edit redlines, inspect a compiled contract diff, optionally restore original PII strictly in-browser for final export, and save Markdown or print-ready PDF.
6. **Offline-First PWA + Chrome Side-Panel Extension:** Installable PWA (`manifest.webmanifest` + `sw.js`) with redacted-only IndexedDB scan history, plus a Manifest V3 Chrome Side-Panel Extension sharing `src/lib/*` to audit any live Terms of Service tab in one click.

### How We Built It
- **Frontend & Ingestion:** React 19, TypeScript 5.7, Vite 6, `pdfjs-dist` (bundled local worker), `mammoth`
- **AI & Security:** `firebase@13.4.0` (`firebase/app`, `firebase/ai` with `InferenceMode.PREFER_ON_DEVICE`, `ONLY_ON_DEVICE`, `Schema`, `generateContentStream`, `countTokens`, `startChat`, `initializeDeviceModel`, and `firebase/app-check` with `ReCaptchaEnterpriseProvider` / `ReCaptchaV3Provider`) + Chrome Built-in AI (`LanguageModel`)
- **Multi-Platform Delivery:** Offline-capable Web PWA + Manifest V3 Chrome Side-Panel Extension (`dist-extension/`)
- **Verification:** `7` offline Vitest suites (`47` tests, zero outbound network calls) covering `piiRedactor`, `documentIngestor`, `scanHistory`, `firebaseClient`, `redlineDiff`, `analysisParser`, and `hybridRouter`.

### Challenges & What We Learned
- Small on-device models can wrap JSON output in markdown fences or hit context limits on long MSAs; we built `parseStructuredAnalysis()` with fence extraction, `countTokens()`-driven chunking with map-reduce merge, and a deterministic heuristic fallback so the UI stays resilient.
- Unflagged Chrome browsers default to `unsupported` for `LanguageModel`; we added an inline 30-second **Enable Gemini Nano** drawer in `TelemetryBar.tsx` with one-click flag copy buttons and a live **Re-probe Nano** action (no page reload needed).

---

## 2. Judge-Proof <= 3-Minute YouTube Demo Script

| Timestamp | Visual / Action | Narration |
| :--- | :--- | :--- |
| **0:00 – 0:25** | **Problem & Privacy Vault:** Open LocalShield (`https://localshield.nuelbuilds.dev`) with the Enterprise SaaS MSA loaded. Click **2. PII Redacted Vault** to show masked `[EMAIL_1]`, `[SSN_1]`, `[AWS_KEY_1]`, `[CARD_1]`, `[API_SECRET_1]` vs. browser-only originals. Add a custom term (`Project Helios`) and show it masked immediately. | "Every time someone pastes a contract into a cloud LLM, emails, SSNs, payment cards, and API keys leak. LocalShield fixes this with Firebase AI Logic Hybrid Inference. Stage 0 masks 12 deterministic PII and secret categories—plus custom codenames—100% locally before a single token touches any model." |
| **0:25 – 1:05** | **Live PDF/Contract + Stage 0.5 Semantic PII + Stage 1 Nano Streaming:** Drop a local `.pdf` or `.docx` contract onto the client-side dropzone (point out local PDF.js/Mammoth badge). Check **Stage 0.5: On-Device Semantic PII (`ONLY_ON_DEVICE`)**, select `PREFER_ON_DEVICE`, and click **Analyze Document with Hybrid AI**. Show the live `LIVE STREAM` preview, `ON-DEVICE` emerald badge (or inline Nano guide + `CLOUD FALLBACK` badge), combined Telemetry Bar, and the **Clause Severity Distribution** bar + filter pills. | "We drop a real PDF parsed strictly in-browser—zero backend upload. Optional Stage 0.5 runs `ONLY_ON_DEVICE` on Gemini Nano to scrub unstructured names and organizations locally. Then Stage 1 streams structured risk clauses and redlines via `InferenceMode.PREFER_ON_DEVICE`, with severity filtering right above the clause stack." |
| **1:05 – 1:45** | **Stage 2 Redacted Cloud Delta + Negotiation Chat + Redline Diff & Local Vault Restore:** Show the **Hybrid Delta Panel** (`Stage 1 vs. Stage 2` new clauses, severity upgrades, cross-clause findings) and combined S1+S2 telemetry. Click **Negotiate** on a critical clause to run a live `startChat()` turn, apply the counter-redline, accept a clause, scroll to **Compiled Redlined Contract Diff**, toggle **Restore Local PII Vault**, and click **Download .md**. | "Stage 2 escalates only the PII-redacted text to Cloud Gemini through Firebase App Check, surfacing cross-clause contradictions in our Stage 1 vs. Stage 2 Delta panel. From any clause, we open a `startChat()` negotiation drawer, accept redlines into a live contract diff, and restore original PII strictly in-browser for final export." |
| **1:45 – 2:20** | **Airplane-Mode Offline PWA Reload + `ONLY_ON_DEVICE`:** Highlight the **Offline Shell Ready** pill and open **Local History** (IndexedDB, redacted-only). Switch Chrome DevTools Network to **Offline**, reload the page cleanly from the Service Worker, select `ONLY_ON_DEVICE`, and run an air-gapped analysis showing Stage 2 automatically blocked with zero network requests. | "LocalShield is an offline-first PWA. Flip Chrome into Airplane Mode and reload—the Service Worker serves the full workbench, IndexedDB keeps redacted history locally, and `ONLY_ON_DEVICE` enforces a strict air-gap that blocks all cloud escalation." |
| **2:20 – 2:55** | **Chrome Side-Panel Extension Auditing Live Terms of Service:** Switch to a live public Terms of Service or Privacy Policy tab, click the **LocalShield** Chrome Extension icon to open the Side Panel, click **Capture Active Tab**, and run a one-click hybrid audit directly beside the page. End on the clean risk brief. | "Finally, our Chrome Side-Panel Extension shares the exact same `firebase/ai` hybrid core so you can audit any live Terms of Service or Privacy Policy tab in one click without copy-pasting. That's LocalShield—private by default, hybrid when you choose." |

---

## 3. Final Devpost Checklist

- [ ] **GitHub Repository Public** with root Apache-2.0 `LICENSE` file.
- [ ] **Zero Secrets Committed:** Verify `.env` is gitignored and only `.env.example` is tracked.
- [ ] **Live Web / Chrome Demo URL** deployed (`https://localshield.nuelbuilds.dev` and `https://build-hybrid-ai.vercel.app`) with App Check verified on both domains.
- [ ] **<= 3-Minute Demo Video** uploaded to YouTube (public or unlisted) showing Stage 0/0.5 PII vault, `ON-DEVICE` + `CLOUD FALLBACK` / `CLOUD ESCALATION` telemetry, offline PWA reload, and Chrome Side-Panel Extension.
- [ ] **Built With Tags on Devpost:** `firebase`, `firebase-ai-logic`, `gemini-nano`, `gemini-api`, `firebase-app-check`, `react`, `typescript`, `chrome-built-in-ai`, `pwa`, `chrome-extension`.
- [ ] **Track Selection:** Submit under **Web / Chrome** (eligible for Best Web/Chrome \$3,000 + Grand Prize \$10,000) before `2026-11-30 22:00 UTC`.
