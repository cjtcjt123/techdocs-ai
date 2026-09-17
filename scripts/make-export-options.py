#!/usr/bin/env python3
"""Generate exportOptions.plist for xcodebuild -exportArchive (manual signing).

Reads from environment (set by the GitHub Actions workflow):
  TEAM_ID      10-char Apple Developer Team ID
  BUNDLE_ID    app bundle identifier, e.g. com.chenjingtao.techdocsai
  PROFILE_NAME name of the provisioning profile as shown in Apple Developer
  SIGN_METHOD  ad-hoc (default) | development | app-store | enterprise

With ad-hoc + an Apple Distribution certificate you get an IPA installable on
the devices whose UDIDs are registered in the provisioning profile (no App Store).
Switch SIGN_METHOD to "development" if you only have a Development cert+profile.
"""
import os
import sys

team = os.environ.get("TEAM_ID", "").strip()
bid = os.environ.get("BUNDLE_ID", "").strip()
prof = os.environ.get("PROFILE_NAME", "").strip()
method = os.environ.get("SIGN_METHOD", "ad-hoc").strip() or "ad-hoc"

if not (team and bid and prof):
    sys.stderr.write(
        "ERROR: TEAM_ID, BUNDLE_ID and PROFILE_NAME must all be set "
        "(repo Settings -> Variables).\n"
    )
    sys.exit(1)

allowed = ("ad-hoc", "development", "app-store", "enterprise")
if method not in allowed:
    sys.stderr.write("WARN: unknown method '%s', falling back to ad-hoc\n" % method)
    method = "ad-hoc"

plist = (
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" '
    '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
    '<plist version="1.0">\n'
    '<dict>\n'
    '\t<key>method</key>\n'
    '\t<string>%s</string>\n' % method
    + '\t<key>signingStyle</key>\n'
    '\t<string>manual</string>\n'
    '\t<key>teamID</key>\n'
    '\t<string>%s</string>\n' % team
    + '\t<key>provisioningProfiles</key>\n'
    '\t<dict>\n'
    '\t\t<key>%s</key>\n' % bid
    + '\t\t<string>%s</string>\n' % prof
    + '\t</dict>\n'
    '</dict>\n'
    '</plist>\n'
)

with open("exportOptions.plist", "w") as f:
    f.write(plist)

print("wrote exportOptions.plist  method=%s  team=%s" % (method, team))
