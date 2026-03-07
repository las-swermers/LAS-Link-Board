// Log on install so we can verify service worker is loading
chrome.runtime.onInstalled.addListener(() => {
  console.log('[LB] Extension installed/updated');
});

console.log('[LB] Background service worker loaded');
