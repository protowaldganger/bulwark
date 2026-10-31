# Bulwark for Safari

Safari on macOS runs web extensions from inside a small Mac app. This folder builds that app on your own Mac with Xcode. Needs Safari 16.4 or later and Xcode.

## Build and install

1. In the repository: `npm install`, then `npm run build`. This writes the Safari version to `dist-safari/`.
2. Run `bash safari/build-safari.command` (or double-click it in Finder). It wraps the extension in an app with Xcode, builds it, installs it as `~/Applications/Bulwark.app` and opens it once.
3. In Safari: **Settings > Extensions**, tick **Bulwark Ad Blocker**, then click **Always Allow on Every Website...**.

## Keep it on after Safari restarts

Safari only keeps signed extensions. Unsigned ones need **Settings > Developer > Allow unsigned extensions** every time Safari starts. A free Apple developer certificate is enough:

1. In Xcode, **Xcode > Settings > Accounts**, click **+** and sign in with your Apple Account.
2. Select **(Personal Team)**, click **Manage Certificates...**, click **+** and choose **Apple Development**.
3. Run the build script again. It finds the team and signs Bulwark with it. Tick Bulwark again in Safari (a signed build counts as a new extension).

The certificate lasts a year. The built app carries your Apple Account name in its signature, so keep it on your own Mac.

## Differences from the Chrome version

- The "Requests blocked" count comes from Safari's list of matched rules when you open the popup. There are no per-day request totals, and the URL tester is hidden.
- About 80 of 17,500 rules use features Safari does not support (some regular expressions, request-method rules and rare request types). They are left out, not run with a different meaning.
- Cookies are stripped from requests. Safari cannot remove cookies from responses, but its own tracking prevention already blocks third-party cookies.
- List updates add new rules but cannot switch off ones the list maintainers removed. Rebuilding clears those out.
