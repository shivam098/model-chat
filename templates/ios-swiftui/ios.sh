#!/bin/bash
# Builds, runs, screenshots and tests this iOS app in the iPhone Simulator on this Mac.
#   ./ios.sh build        generate the Xcode project (XcodeGen) and build for the Simulator
#   ./ios.sh run          build, install and launch it, then save a screenshot
#   ./ios.sh screenshot   save a screenshot of the Simulator
#   ./ios.sh test         run the unit tests
# Screenshots go to .modelchat/screenshots/, where Model Chat shows them in the chat.
# Set SIMULATOR_ID to use a particular simulator. No Apple ID or signing is needed for the Simulator.
set -euo pipefail
cd "$(dirname "$0")"
APP=CounterApp
BUNDLE_ID=local.modelchat.counterapp
DERIVED=build
SHOTS=.modelchat/screenshots

simulator() {
  if [ -n "${SIMULATOR_ID:-}" ]; then echo "$SIMULATOR_ID"; return; fi
  xcrun simctl list devices available -j | node -e '
    const devices = JSON.parse(require("fs").readFileSync(0, "utf8")).devices;
    const phones = Object.entries(devices).filter(([runtime]) => runtime.includes("iOS"))
      .flatMap(([runtime, list]) => list.map(device => ({ ...device, runtime }))).filter(device => device.name.startsWith("iPhone"));
    const pick = phones.find(device => device.state === "Booted")
      || phones.sort((a, b) => b.runtime.localeCompare(a.runtime, undefined, { numeric: true }))[0];
    if (!pick) { console.error("No iPhone simulator is installed. In Xcode open Settings > Components and add an iOS simulator."); process.exit(1); }
    console.log(pick.udid);'
}
generate() {
  command -v xcodegen >/dev/null || { echo "XcodeGen is missing. Install it with: brew install xcodegen" >&2; exit 1; }
  xcodegen generate --quiet
}
build() {
  generate
  local id; id=$(simulator)
  xcodebuild -project "$APP.xcodeproj" -scheme "$APP" -destination "id=$id" -derivedDataPath "$DERIVED" -quiet build
  echo "Built $APP for the Simulator."
}
screenshot() {
  local id; id=$(simulator)
  mkdir -p "$SHOTS"
  local file="$SHOTS/simulator-$(date +%Y%m%d-%H%M%S).png"
  xcrun simctl io "$id" screenshot "$file" >/dev/null
  echo "Screenshot: $file"
}
run() {
  build
  local id; id=$(simulator)
  xcrun simctl bootstatus "$id" -b >/dev/null
  # Shows the Simulator window on this Mac; skipped on build servers.
  if [ -z "${CI:-}" ]; then open -a Simulator --args -CurrentDeviceUDID "$id" || true; fi
  xcrun simctl install "$id" "$DERIVED/Build/Products/Debug-iphonesimulator/$APP.app"
  xcrun simctl launch "$id" "$BUNDLE_ID" >/dev/null
  sleep "${SCREENSHOT_DELAY:-4}"
  echo "Running $APP on the Simulator."
  screenshot
}
run_tests() {
  generate
  local id; id=$(simulator)
  xcodebuild -project "$APP.xcodeproj" -scheme "$APP" -destination "id=$id" -derivedDataPath "$DERIVED" test 2>&1 \
    | grep -E "error:|warning: .*(fail|error)|Test Case .*(passed|failed)|Executed [0-9]+ tests?|\*\* TEST (SUCCEEDED|FAILED) \*\*"
}

case "${1:-}" in
  build) build ;;
  run) run ;;
  screenshot) screenshot ;;
  test) run_tests ;;
  *) echo "Usage: ./ios.sh build|run|screenshot|test" >&2; exit 2 ;;
esac
