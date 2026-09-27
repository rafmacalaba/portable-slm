// Never load the model in this worker: Chrome suspends idle extension service workers.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
