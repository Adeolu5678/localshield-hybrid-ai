// Background service worker for LegalEase extension.
// Toolbar icon toggles the floating LegalEase drawer in the active tab.
chrome.action.onClicked.addListener((tab) => {
  if (tab.id) {
    chrome.tabs.sendMessage(tab.id, { type: 'LEGALEASE_TOGGLE_DRAWER' }).catch(() => {});
  }
});

interface CloudDraftRequest {
  type: 'LEGALEASE_CLOUD_DRAFT';
  prompt: string;
  previousDraft?: string;
  apiKey?: string;
}

interface CompanionExplainRequest {
  type: 'LEGALEASE_COMPANION_EXPLAIN';
  selectedText: string;
  documentContext?: string;
  followUpQuestion?: string;
  question?: string;
  apiKey?: string;
}

type BackgroundRequest = CloudDraftRequest | CompanionExplainRequest;

function callGemini(
  apiKey: string,
  systemInstruction: string,
  userPrompt: string,
  sendResponse: (res: { ok: boolean; text?: string; error?: string }) => void,
): void {
  fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      }),
    },
  )
    .then(async (res) => {
      if (!res.ok) {
        const errText = await res.text().catch(() => res.statusText);
        sendResponse({ ok: false, error: `HTTP ${res.status}: ${errText}` });
        return;
      }
      const data = (await res.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      const text = data.candidates?.[0]?.content?.parts
        ?.map((part) => part.text ?? '')
        .join('')
        .trim();
      if (!text) {
        sendResponse({ ok: false, error: 'Empty response from Gemini.' });
        return;
      }
      sendResponse({ ok: true, text });
    })
    .catch((err: unknown) => {
      sendResponse({
        ok: false,
        error: err instanceof Error ? err.message : 'Request failed.',
      });
    });
}

chrome.runtime.onMessage.addListener((rawMessage: unknown, _sender, sendResponse) => {
  const message = rawMessage as Partial<BackgroundRequest> | null;
  if (!message || (message.type !== 'LEGALEASE_CLOUD_DRAFT' && message.type !== 'LEGALEASE_COMPANION_EXPLAIN')) {
    return false;
  }

  const apiKey = message.apiKey?.trim();
  if (!apiKey) {
    sendResponse({ ok: false, error: 'Missing Gemini API key.' });
    return false;
  }

  if (message.type === 'LEGALEASE_COMPANION_EXPLAIN') {
    if (typeof message.selectedText !== 'string' || !message.selectedText.trim()) {
      sendResponse({ ok: false, error: 'Missing selected text.' });
      return false;
    }
    const followUp = (message.followUpQuestion ?? message.question)?.trim();
    const docContext = message.documentContext?.trim().slice(0, 45000);
    const contextBlock = docContext ? `Document context:\n${docContext}\n\n` : '';
    const systemInstruction = followUp
      ? 'You are LegalEase Companion, a direct, conversational legal assistant. Answer the user\'s exact question directly and concisely in plain everyday English using the provided document context and highlighted text. If the user asks to navigate to, jump to, or review a specific section (e.g., Section 11.4), locate that section in the document context and explain it clearly. Do not use a "What this means for you / Watch out for" template.'
      : 'You are LegalEase Companion. Explain the highlighted legal text in plain, everyday English — zero legal jargon, max 3-4 short sentences total. Structure your answer with two short parts: "What this means for you:" and "Watch out for:". Be direct, practical, and easy to read.';
    const userPrompt = followUp
      ? `${contextBlock}Highlighted text:\n"${message.selectedText.trim()}"\n\nUser question: ${followUp}`
      : `${contextBlock}Explain this highlighted text in plain everyday English:\n"${message.selectedText.trim()}"`;
    callGemini(apiKey, systemInstruction, userPrompt, sendResponse);
    return true;
  }

  const draftMsg = message as Partial<CloudDraftRequest>;
  if (typeof draftMsg.prompt !== 'string') {
    return false;
  }

  const systemInstruction =
    'You are LegalEase, a commercial contract drafting assistant. When the user asks to draft an agreement or contract (e.g., co-founder agreement, NDA, freelance contract, MSA), output a complete, properly structured legal contract with: (1) Title, Parties & Effective Date ([COMPANY_NAME], [COUNTERPARTY_NAME], [DATE]); (2) Numbered Sections covering Scope/Role, Compensation/Equity & Vesting (if applicable), Intellectual Property Assignment, Confidentiality, Term & Termination, Limitation of Liability, and Governing Law & Dispute Resolution; and (3) a Signature Block. Only output a single standalone clause if the user explicitly asks for a single clause. Return only the ready-to-insert legal text with no preamble or markdown fences.';
  const userPrompt = draftMsg.previousDraft
    ? `Refine the following contract draft based on this instruction: "${draftMsg.prompt}".\n\nCurrent draft:\n${draftMsg.previousDraft}`
    : `Draft a clear, balanced contract or clause for: "${draftMsg.prompt}".`;

  callGemini(apiKey, systemInstruction, userPrompt, sendResponse);
  return true;
});

export {};
