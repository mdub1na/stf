# Linux iOS Appium node

This node runs Appium 3.8.0 / XCUITest 12.18.1 beside an existing Linux iOS
runtime. A loopback adapter on port 18101 attaches Appium to the existing WDA
session on port 18100. It never creates or deletes a WDA session and restores
shared WDA settings when Appium closes. No WDA port is published.

The initial single-phone hardware trial passed through the public HTTPS Grid,
including native element inspection, scrolling, screenshots and concurrent STF
screen viewing. Three consecutive post-restart runs passed with the same WDA
session; only the Appium container restarted. See the
[validation record](../../docs/appium-validation-2026-10-18.md).

## Install beside an existing runtime

The selected runtime must already have WDA ready on loopback port 18100.
Applying or removing the sidecar recreates that phone's pod: first ensure it is
free and save the current Deployment for rollback. Work on one phone at a time.
This setup does not build, sign, install or replace WDA. XCUITest is installed
from npm when the trial container starts, so startup requires registry access;
a production image can bake in the same pinned driver.

```sh
node kuber/appium-tests/ios-node/render-config.mjs "$IOS_NAMESPACE" | \
  kubectl --kubeconfig "$KUBECONFIG" apply -f -
kubectl --kubeconfig "$KUBECONFIG" -n "$IOS_NAMESPACE" \
  patch deployment "$IOS_DEPLOYMENT" --type=strategic \
  --patch-file kuber/appium-tests/ios-node/sidecar-patch.json
kubectl --kubeconfig "$KUBECONFIG" -n "$IOS_NAMESPACE" \
  rollout status deployment/"$IOS_DEPLOYMENT" --timeout=180s
```

The supervisor starts Appium and its adapter together and stops both if either
process exits. Readiness checks both Appium and the live WDA session; liveness
checks the two processes without treating a disconnected phone as a crashed
Appium server. ConfigMap symlink startup has an automated regression test.

For direct diagnostics, forward port 4723, set the matching phone's `STF_SERIAL`
and `APPIUM_SERVER_URL=http://127.0.0.1:14723`, then run
`stfAppiumIosSettingsTest`. Omit `IOS_WDA_URL`: the sidecar has its loopback
default. A direct iOS server requires an explicit STF serial to avoid reserving
a different phone.

## Register this phone with Grid

Keep a target JSON file outside Git. It contains the selected runtime's
namespace, Deployment, exact pod selector, UDID and STF-reported iOS version:

```json
{
  "namespace": "stf-ios-prototype",
  "deployment": "ios-prototype",
  "selector": {"app": "stf-ios-prototype"},
  "udid": "YOUR_DEVICE_UDID",
  "platformVersion": "27.0.1"
}
```

The selector must identify only this runtime. The example matches the original
single-phone preview; fleet-generated Deployments have their own selectors.

```sh
node kuber/appium-tests/ios-node/render-grid.mjs "$IOS_TARGET_JSON" > "$IOS_GRID_RESOURCES"
kubectl --kubeconfig "$KUBECONFIG" apply -f "$IOS_GRID_RESOURCES"
```

The renderer creates a Service and NetworkPolicy beside the phone, plus a
single-session Selenium relay and ConfigMap in namespace `appium`. Only that
relay can connect to port 4723. WDA remains on loopback. The relay advertises
both UDID and `appium:platformVersion`; Selenium requires an exact OS-version
match when the client supplies it. Re-render after an iOS upgrade. A config
hash updates the relay pod when its stereotype changes.

Use `APPIUM_SERVER_URL=https://appium-grid.finservice.tech` for the farm test.
It automatically selects a free iPhone from registered UP relay UDIDs. All three
preview iPhones now have dedicated relays; unregistered phones are not reserved.
`STF_SERIAL` remains an optional pin. Readiness and version mismatches fail before session creation.

## Rollback

First stop new test runs and verify that the phone and relay have no sessions.
Delete only the generated relay resources, then remove the sidecar:

```sh
kubectl --kubeconfig "$KUBECONFIG" delete -f "$IOS_GRID_RESOURCES"
kubectl --kubeconfig "$KUBECONFIG" -n "$IOS_NAMESPACE" \
  patch deployment "$IOS_DEPLOYMENT" --type=strategic \
  --patch-file kuber/appium-tests/ios-node/remove-sidecar-patch.json
kubectl --kubeconfig "$KUBECONFIG" -n "$IOS_NAMESPACE" \
  rollout status deployment/"$IOS_DEPLOYMENT" --timeout=180s
```

The shared `ios-appium-config` ConfigMap can be removed after the last sidecar
using it is gone. Phone runtime volumes, pairing records and signed WDA remain.
