// Background service worker for LegalEase extension.
// Toolbar icon toggles the floating LegalEase drawer in the active tab.
chrome.action.onClicked.addListener((tab) => {
  if (tab.id) {
    chrome.tabs.sendMessage(tab.id, { type: 'LEGALEASE_TOGGLE_DRAWER' }).catch(() => {});
  }
});

export {};
