// Runs right before youtube-main.js when ad-free requests are on. The
// attribute is read and removed by youtube-main.js before any page script.
document.documentElement && document.documentElement.setAttribute('data-bwf', '1');
