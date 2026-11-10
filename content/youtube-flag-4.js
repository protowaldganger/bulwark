// Registered right before youtube-main.js when ad-free requests are on: start
// with method 4 (see background/ytadfree.js). youtube-main.js reads the
// attribute and removes it before any page script runs.
document.documentElement && document.documentElement.setAttribute('data-bwf', '4');
