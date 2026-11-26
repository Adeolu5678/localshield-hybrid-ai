function configureSidePanelBehavior(): void {
  if (typeof chrome !== 'undefined' && chrome.sidePanel?.setPanelBehavior) {
    void chrome.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: true })
      .catch(() => {
        // Ignore if running outside Chrome 116+ sidePanel environment.
      });
  }
}

configureSidePanelBehavior();

if (typeof chrome !== 'undefined' && chrome.runtime?.onInstalled) {
  chrome.runtime.onInstalled.addListener(() => {
    configureSidePanelBehavior();
  });
}

if (typeof chrome !== 'undefined' && chrome.runtime?.onStartup) {
  chrome.runtime.onStartup.addListener(() => {
    configureSidePanelBehavior();
  });
}
