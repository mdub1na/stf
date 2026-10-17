# Linux iOS Appium node trial

The patch adds Appium 3.8.0 / XCUITest 12.18.1 beside an existing Linux iOS
runtime. A loopback adapter on port 18101 attaches Appium to the existing WDA
session on port 18100. It never creates or deletes a WDA session and restores
the shared WDA settings when Appium closes. No WDA port is published.
It does not build, sign, install or replace WDA. XCUITest is installed from npm
when this trial container starts; a production image should bake the driver in.

Applying or removing the sidecar recreates the selected phone pod. Confirm that
it is free, preserve the existing Deployment for rollback, and perform the trial
on one phone before adding more. The adapter has device-free lifecycle
regression tests; coexistence with STF must still be checked on hardware before registering this node with Grid.

```sh
node kuber/appium-tests/ios-node/render-config.mjs "$IOS_NAMESPACE" | \
  kubectl --kubeconfig "$KUBECONFIG" apply -f -
kubectl --kubeconfig "$KUBECONFIG" -n "$IOS_NAMESPACE" \
  patch deployment "$IOS_DEPLOYMENT" --type=strategic \
  --patch-file kuber/appium-tests/ios-node/sidecar-patch.json
kubectl --kubeconfig "$KUBECONFIG" -n "$IOS_NAMESPACE" \
  rollout status deployment/"$IOS_DEPLOYMENT" --timeout=180s
kubectl --kubeconfig "$KUBECONFIG" -n "$IOS_NAMESPACE" \
  port-forward deployment/"$IOS_DEPLOYMENT" 14723:4723
```

Select that exact phone with `STF_SERIAL` and set
`APPIUM_SERVER_URL=http://127.0.0.1:14723` when running `stfAppiumIosSettingsTest`.
Do not supply `IOS_WDA_URL`: the sidecar uses its own pod-local WDA by default.
