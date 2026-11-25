# LocalShield — HybridDoc Brief: Devpost Submission Guide

## 1. Devpost Submission Writeup

### Project Name
**LocalShield — HybridDoc Brief**

### Tagline
Zero-leakage contract, privacy-policy, and technical document risk analyzer powered by Firebase AI Logic hybrid inference (`PREFER_ON_DEVICE`), Chrome Gemini Nano, and Firebase App Check.

### Inspiration
Founders, security engineers, and legal reviewers paste confidential contracts, DPAs, and API terms into cloud chatbots every day—often leaking SSNs, customer emails, corporate card numbers, IBANs, and live API secrets (`sk-live-...`) in the prompt payload. On-device models like Chrome's Gemini Nano keep raw sensitive documents local, while cloud Gemini excels at deep cross-clause synthesis. We built LocalShield to combine both cleanly through **Firebase AI Logic's hybrid inference SDK**.

### What It Does
1. **Local Deterministic PII Vault (Stage 0):** Before any inference call executes, LocalShield scans the document in-browser and replaces emails, phone numbers, SSNs, payment cards, IBANs, IPv4 addresses, street addresses, and API keys with deterministic tokens (`[EMAIL_1]`, `[SSN_1]`, `[API_SECRET_1]`). Raw values never leave the browser.
2. **On-Device First Triage (Stage 1):** Using `getGenerativeModel(ai, { mode: InferenceMode.PREFER_ON_DEVICE })` from `firebase/ai`, LocalShield extracts risky clauses (uncapped liability, silent auto-renewal, AI model-training licenses, unilateral modification, delayed breach notice), assigns severity (`critical`/`high`/`medium`/`low`), and drafts copyable redline counter-proposals—running on Chrome Gemini Nano when available and falling back seamlessly to Cloud Gemini (`gemini-3-flash-preview`) when needed.
3. **App Check-Guarded Cloud Escalation (Stage 2):** When the user enables Stage 2 and is online (and not in `ONLY_ON_DEVICE` air-gapped mode), LocalShield sends **only the PII-redacted text** to Cloud Gemini via `GoogleAIBackend` protected by Firebase App Check (`ReCaptchaV3Provider` / debug token) to detect compound cross-clause contradictions and GDPR/SOC 2 gaps.
4. **Live Hybrid Telemetry Bar:** Displays real-time `ON-DEVICE` vs `CLOUD FALLBACK` vs `CLOUD ESCALATION` badges directly from `response.inferenceSource`, Chrome `LanguageModel.availability()`, `initializeDeviceModel()` download progress, Firebase App Check token verification status, latency (`ms`), and exact/estimated token counts.

### How We Built It
- **Frontend:** React 19 + TypeScript + Vite
- **AI & Security:** `firebase@13.4.0` (`firebase/app`, `firebase/ai` with `InferenceMode.PREFER_ON_DEVICE` and `Schema`, `firebase/app-check` with `ReCaptchaV3Provider`) + Chrome Built-in AI (`LanguageModel`)
- **Verification:** Offline deterministic Vitest suite validating the PII redactor, structured JSON/fence parser, and hybrid router state machine (`ON-DEVICE`, `CLOUD FALLBACK`, `ONLY_ON_DEVICE` air-gap guard, offline handling).

### Challenges & What We Learned
- Small on-device models occasionally wrap JSON responses in markdown fences or preamble; we built `parseStructuredAnalysis()` with fence extraction and a deterministic heuristic fallback so the UI never crashes.
- Mapping `GenerativeModel.initializeDeviceModel(onDownloadProgress)` to a user-gesture button satisfies Chrome Prompt API activation rules while giving users live download visibility.

---

## 2. 3-Minute YouTube Demo Script

| Time | Visual / Action | Narration |
| :--- | :--- | :--- |
| **0:00 – 0:25** | Show LocalShield landing workbench with the Enterprise SaaS MSA loaded. Point at the **Local Zero-Leakage PII Vault** panel. | "Every time someone pastes a contract or policy into an AI tool, secrets leak. LocalShield fixes this using Firebase AI Logic Hybrid Inference. Before a single token touches any model, our local PII vault masks emails, SSNs, corporate cards, and API keys right in the browser." |
| **0:25 – 0:55** | Click **Local Vault** tab to show masked tokens vs browser-only originals. Highlight Telemetry Bar (`Chrome Gemini Nano` status + `Firebase App Check` verified pill). | "Here in the Local Vault, `sk-live-...` and `123-45-6789` stay strictly in browser memory. Up top, our live Telemetry Bar probes Chrome's `LanguageModel.availability()` and verifies our Firebase App Check token." |
| **0:55 – 1:40** | Select `PREFER_ON_DEVICE` and click **Analyze Document with Hybrid AI**. Show the live `ON-DEVICE` emerald badge (or `Warm Up Nano` progress + `CLOUD FALLBACK` transition if disabling Nano). | "With `InferenceMode.PREFER_ON_DEVICE`, Firebase AI Logic routes Stage 1 clause extraction directly to on-device Gemini Nano. We get structured risk clauses, severity ratings, and copyable redline counter-proposals with zero cloud calls." |
| **1:40 – 2:20** | Toggle Stage 2 Cloud Escalation ON and show **Cross-Clause Compound Findings** + `CLOUD ESCALATION` badge + `usageMetadata` token counts. Then toggle `ONLY_ON_DEVICE` (or Chrome DevTools Offline) to show Stage 2 cleanly blocked. | "When we need deeper multi-clause synthesis, Stage 2 escalates only the PII-redacted brief to Cloud Gemini through App Check. Flip to `ONLY_ON_DEVICE` or go offline, and LocalShield enforces a strict air-gap—blocking all outbound escalation." |
| **2:20 – 3:00** | Click **Copy / Export Brief (.md)**, show terminal running `npm test` and `npm run build` passing cleanly, and wrap up. | "Every brief exports to clean Markdown, and our entire hybrid router, PII vault, and parser are verified offline with Vitest. That's LocalShield—private by default, hybrid when you choose." |

---

## 3. Final Devpost Checklist

- [ ] **GitHub Repository Public** with root Apache-2.0 `LICENSE` file.
- [ ] **Zero Secrets Committed:** Verify `.env` is gitignored and only `.env.example` is tracked.
- [ ] **Live Web / Chrome Demo URL** deployed (e.g., Firebase Hosting or Vercel) with App Check debug/production key configured.
- [ ] **3-Minute Demo Video** uploaded to YouTube/Vimeo (public or unlisted) showing both `ON-DEVICE` and `CLOUD FALLBACK` telemetry badges.
- [ ] **Built With Tags on Devpost:** `firebase`, `firebase-ai-logic`, `gemini-nano`, `gemini-api`, `firebase-app-check`, `react`, `typescript`, `chrome-built-in-ai`.
- [ ] **Track Selection:** Submit under **Web / Chrome** (eligible for Best Web/Chrome \$3,000 + Grand Prize \$10,000) before `2026-11-30 22:00 UTC`.
