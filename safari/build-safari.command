#!/bin/bash
# Builds Bulwark as a Safari extension on this Mac and installs it.
# Run `npm run build` in the repository first (it writes dist-safari/), then
# double-click this file or run: bash safari/build-safari.command
#
# Uses Apple's own tools (Xcode): safari-web-extension-converter wraps the
# extension in a small Mac app, xcodebuild builds it, and the app is copied
# to ~/Applications. Nothing is downloaded and nothing leaves this Mac.

set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# A "Safari extension" folder next to this script wins; otherwise the
# repository's dist-safari/ build is used.
EXT="$HERE/Safari extension"
[ -d "$EXT" ] || EXT="$HERE/../dist-safari"
WORK="$HERE/.build"
APP_DEST="$HOME/Applications/Bulwark.app"

say() { printf '\n\033[1m%s\033[0m\n' "$1"; }
fail() { printf '\n\033[31m%s\033[0m\n' "$1"; echo; read -r -p "Press Return to close." _; exit 1; }

[ -f "$EXT/manifest.json" ] || fail "No Safari build found. Run 'npm run build' in the repository first."

say "Checking Xcode and Safari"
xcrun --find safari-web-extension-converter >/dev/null 2>&1 \
  || fail "Xcode is needed. Install it from the App Store, open it once, then run this again."
SAFARI_VERSION="$(defaults read /Applications/Safari.app/Contents/Info.plist CFBundleShortVersionString 2>/dev/null || echo unknown)"
echo "Safari $SAFARI_VERSION"
case "$SAFARI_VERSION" in
  1[0-5].*|16.[0-3]*) fail "Bulwark needs Safari 16.4 or later. Update macOS first." ;;
esac

# Your free Apple development certificate (Xcode > Settings > Accounts).
# Safari only keeps signed extensions on after it restarts. The team comes
# from a certificate in the keychain, or else from the Apple ID signed in
# to Xcode (Xcode can then use a certificate it keeps in your account).
TEAM="$(security find-certificate -a -c "Apple Development" -p 2>/dev/null \
  | openssl x509 -noout -subject 2>/dev/null | sed -n 's/.*OU *= *\([A-Z0-9]\{10\}\).*/\1/p' | head -1 || true)"
if [ -n "$TEAM" ] && ! security find-identity -v -p codesigning 2>/dev/null | grep -q "Apple Development"; then TEAM=""; fi
TEAM_SOURCE="certificate"
if [ -z "$TEAM" ]; then
  TEAM="$( (defaults read com.apple.dt.Xcode IDEProvisioningTeamByIdentifier 2>/dev/null; defaults read com.apple.dt.Xcode IDEProvisioningTeams 2>/dev/null) \
    | sed -n 's/.*teamID = "\{0,1\}\([A-Z0-9]\{10\}\)"\{0,1\};.*/\1/p' | head -1 || true)"
  TEAM_SOURCE="Xcode account"
fi
# Bundle IDs must be unique per Apple account, so a signed build adds the team.
APP_ID="local.bulwark"
[ -n "$TEAM" ] && APP_ID="local.bulwark.$(printf '%s' "$TEAM" | tr 'A-Z' 'a-z')"
EXT_ID="$APP_ID.extension"
if [ -n "$TEAM" ]; then echo "Signing for team $TEAM (from your $TEAM_SOURCE)"
else echo "No Apple Development certificate or Xcode account found: building unsigned"; fi

say "Creating the Xcode project"
rm -rf "$WORK"
mkdir -p "$WORK"
xcrun safari-web-extension-converter "$EXT" \
  --project-location "$WORK" \
  --app-name "Bulwark" \
  --bundle-identifier "$APP_ID" \
  --swift --macos-only --copy-resources --no-open --no-prompt --force

PROJ="$(find "$WORK" -maxdepth 3 -name '*.xcodeproj' | head -1)"
[ -n "$PROJ" ] || fail "The converter did not create an Xcode project."
SCHEME="$(xcodebuild -list -project "$PROJ" 2>/dev/null | awk '/Schemes:/{f=1;next} f&&NF{print;exit}' | sed 's/^ *//')"
[ -n "$SCHEME" ] || SCHEME="Bulwark"
echo "Project: $PROJ"
echo "Scheme:  $SCHEME"

# Give the app and the extension matching IDs: the extension's ID must
# start with the app's ID, or Xcode refuses to embed it. Works with both
# project formats (project.pbxproj, and project.xcproj from Xcode 27.2).
say "Setting bundle identifiers"
PBX="$PROJ/project.pbxproj"
[ -f "$PBX" ] || PBX="$PROJ/project.xcproj"
[ -f "$PBX" ] || fail "Can't find the project file inside $PROJ."
echo "Converter chose:"; grep -oE 'PRODUCT_BUNDLE_IDENTIFIER"? *[:=] *"?[A-Za-z0-9.-]+' "$PBX" | sed -E 's/.*[:=] *"?//' | sort -u | sed 's/^/  /'
APP_ID="$APP_ID" EXT_ID="$EXT_ID" /usr/bin/perl -pi -e 's/(PRODUCT_BUNDLE_IDENTIFIER"? *[:=] *"?)([A-Za-z0-9.-]+)/my ($k, $v) = ($1, $2); $k . ($v =~ m{\.extension$}i ? $ENV{EXT_ID} : $ENV{APP_ID})/ge' "$PBX"
echo "Now:"; grep -oE 'PRODUCT_BUNDLE_IDENTIFIER"? *[:=] *"?[A-Za-z0-9.-]+' "$PBX" | sed -E 's/.*[:=] *"?//' | sort -u | sed 's/^/  /'
grep -qE "PRODUCT_BUNDLE_IDENTIFIER\"? *[:=] *\"?$EXT_ID([\";]|\$)" "$PBX" || fail "Could not set the extension's bundle identifier."
# The app's own window looks the extension up by its ID.
find "$WORK" -name '*.swift' -print0 | EXT_ID="$EXT_ID" xargs -0 /usr/bin/perl -pi -e 's/(extensionBundleIdentifier\s*=\s*)"[^"]*"/$1"$ENV{EXT_ID}"/'

LOG="$WORK/build.log"
PRODUCTS="$WORK/DerivedData/Build/Products/Release"
build() {
  rm -rf "$PRODUCTS"
  set +e
  xcodebuild -project "$PROJ" -scheme "$SCHEME" -configuration Release -destination 'platform=macOS' \
    -derivedDataPath "$WORK/DerivedData" "$@" build > "$LOG" 2>&1
  local status=$?
  set -e
  grep -E 'error:|BUILD (SUCCEEDED|FAILED)' "$LOG" | sort -u || true
  return $status
}

SIGNED=no
if [ -n "$TEAM" ]; then
  say "Building and signing with your development certificate"
  if build DEVELOPMENT_TEAM="$TEAM" CODE_SIGN_STYLE=Automatic -allowProvisioningUpdates; then SIGNED=yes
  else
    echo "Automatic signing didn't work, trying the certificate directly"
    if build DEVELOPMENT_TEAM="$TEAM" CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY="Apple Development" PROVISIONING_PROFILE_SPECIFIER=; then SIGNED=yes; fi
  fi
fi
if [ "$SIGNED" = no ]; then
  say "Building, signed to run locally (Safari will need unsigned extensions allowed)"
  build CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM= \
    || fail "The build failed. Full log: $LOG"
fi
APP="$PRODUCTS/Bulwark.app"
[ -d "$APP/Contents/PlugIns" ] || fail "The build finished without the Safari extension inside. Full log: $LOG"

say "Installing to ~/Applications"
mkdir -p "$HOME/Applications"
rm -rf "$APP_DEST"
ditto "$APP" "$APP_DEST"
open "$APP_DEST"

# Check the installed copy's signature (read into a variable first: with
# pipefail, grep -q closing the pipe early would look like a failure).
SIG="$(codesign -dv "$APP_DEST/Contents/PlugIns/"*.appex 2>&1 || true)"
case "$SIG" in *"Authority=Apple Development"*) ;; *) SIGNED=no ;; esac

# Remove the build copy so Safari lists Bulwark only once. Keep the log.
LSREG=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
for x in "$APP/Contents/PlugIns/"*.appex; do pluginkit -r "$x" >/dev/null 2>&1 || true; done
[ -x "$LSREG" ] && "$LSREG" -u "$APP" >/dev/null 2>&1 || true
cp "$LOG" "$HERE/.last-build.log" 2>/dev/null || true
rm -rf "$WORK"

say "Done"
cat <<EOF
Bulwark is installed. In Safari:
  1. Safari > Settings > Extensions, tick Bulwark.
  2. Click "Edit Websites..." (or the Bulwark entry) and set
     "Other websites" to Allow, so it can block ads everywhere.
EOF
if [ "$SIGNED" = yes ]; then
cat <<EOF
  Bulwark is signed with your development certificate, so it stays on
  when Safari restarts. "Allow unsigned extensions" is no longer needed.
EOF
else
cat <<EOF
  Bulwark is NOT signed, so Safari hides it after every restart until
  you tick Settings > Developer > "Allow unsigned extensions" again.
  To fix that for good: Xcode > Settings > Accounts, add your Apple ID,
  select "(Personal Team)", click "Manage Certificates...", click + and
  choose "Apple Development". Then run this script again.
EOF
fi
echo
read -r -p "Press Return to close." _
