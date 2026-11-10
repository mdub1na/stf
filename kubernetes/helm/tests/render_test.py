"""Hardware-free template contracts. Requires Helm and PyYAML; no cluster access."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
import yaml

CHART = Path(__file__).resolve().parents[1]
HELM = os.environ.get('HELM', 'helm')

def render(values=None, namespace='test-stf', release='stf', upgrade=False, failure=None):
    config = {'session': {'existingSecret': 'stf-session'}}
    config.update(values or {})
    with tempfile.NamedTemporaryFile('w', suffix='.json') as f:
        json.dump(config, f); f.flush()
        cmd = [HELM, 'template', release, str(CHART), '--namespace', namespace, '-f', f.name]
        if upgrade: cmd += ['--is-upgrade']
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    if failure:
        if p.returncode == 0 or failure not in p.stderr: raise AssertionError(p.stderr)
        return
    if p.returncode: raise AssertionError(p.stderr)
    return [x for x in yaml.safe_load_all(p.stdout) if x]

def obj(items, kind, name):
    return next(x for x in items if x['kind'] == kind and x['metadata']['name'] == name)

def iphone(name='iphone-a', udid='00008100-0000000000000001'):
    return {'name': name, 'udid': udid, 'wdaBundleId': 'com.example.WDA.xctrunner',
            'tokenSecret': name + '-token', 'nodeSelector': {'kubernetes.io/hostname': 'usb-a'}}

IOS_IMAGE = {'repository': 'example.invalid/ios-runtime', 'tag': 'test'}

class ChartTest(unittest.TestCase):
    def test_default_core_has_no_usb_and_exposes_only_http(self):
        items = render()
        self.assertEqual(len([x for x in items if x['kind'] == 'Deployment']), 13)
        self.assertEqual(obj(items, 'Service', 'stf-proxy')['spec']['ports'][0]['port'], 7100)
        self.assertFalse(any(x['kind'] == 'Secret' for x in items))
        self.assertFalse(any(
            feature in x['metadata']['name'] for x in items for feature in ('coordinator', 'appium')))
        for x in items:
            spec = x.get('spec', {})
            if x['kind'] == 'Service':
                self.assertEqual(spec.get('type', 'ClusterIP'), 'ClusterIP')
            pod = spec.get('template', {}).get('spec', {})
            self.assertFalse(pod.get('hostNetwork', False))
            self.assertFalse(any('hostPath' in v for v in pod.get('volumes', [])))

    def test_missing_secret_and_invalid_origin_fail_without_cluster(self):
        render({'session': {'existingSecret': ''}}, failure='existingSecret')
        render({'publicOrigin': 'https://stf.example.com/path'}, failure='publicOrigin')

    def test_maestro_coordinator_uses_release_services_and_persistent_singleton(self):
        values = {
            'coordinator': {'enabled': True, 'existingSecret': 'lease-credentials', 'maxParallel': 8},
            'android': {'providers': [
                {'name': 'usb', 'nodeSelector': {'kubernetes.io/hostname': 'usb-a'}},
                {'name': 'remote', 'externalAdb': {'host': 'adb.example', 'port': 15037}}]},
            'resourceNames': {'api': 'existing-api', 'android-usb': 'usb-provider', 'adb-usb': 'usb-adb'},
            'ports': {'http': 3100}, 'imagePullSecrets': [{'name': 'registry-key'}]
        }
        items = render(values, release='farm', namespace='test-farm')
        name = 'farm-stf-coordinator'
        deployment = obj(items, 'Deployment', name)['spec']
        self.assertEqual(deployment['replicas'], 1)
        self.assertEqual(deployment['strategy'], {'type': 'Recreate', 'rollingUpdate': None})
        pod = deployment['template']['spec']
        self.assertFalse(pod['automountServiceAccountToken'])
        self.assertFalse(pod['enableServiceLinks'])
        self.assertEqual(pod['securityContext']['fsGroup'], 1000)
        self.assertEqual(pod['imagePullSecrets'], [{'name': 'registry-key'}])
        self.assertEqual(pod['initContainers'][0]['name'], 'wait-migration')
        self.assertFalse(any('hostPath' in v for v in pod['volumes']))
        container = pod['containers'][0]
        self.assertEqual(container['image'], obj(items, 'Deployment', 'existing-api')['spec']
                         ['template']['spec']['containers'][0]['image'])
        self.assertEqual(container['command'], ['stf', 'coordinator'])
        self.assertIn('--stf-api-url=http://existing-api:3100/api/v1', container['args'])
        self.assertIn('--public-url=http://farm-stf-coordinator.test-farm.svc:8080', container['args'])
        self.assertIn('--max-parallel=8', container['args'])
        self.assertFalse(any('--appium-grid-url=' in arg for arg in container['args']))
        self.assertEqual(container['readinessProbe']['httpGet']['path'], '/readyz')
        volumes = {v['name']: v for v in pod['volumes']}
        self.assertEqual(volumes['credentials']['secret']['secretName'], 'lease-credentials')
        self.assertEqual(volumes['credentials']['secret']['items'], [
            {'key': 'stf-token', 'path': 'stf-token'}, {'key': 'api-token', 'path': 'api-token'}])
        claim = obj(items, 'PersistentVolumeClaim', name + '-state')
        self.assertEqual(volumes['state']['persistentVolumeClaim']['claimName'], claim['metadata']['name'])
        self.assertEqual(claim['metadata']['annotations']['helm.sh/resource-policy'], 'keep')
        self.assertEqual(claim['spec']['accessModes'], ['ReadWriteOnce'])
        service = obj(items, 'Service', name)['spec']
        self.assertEqual(service['type'], 'ClusterIP')
        self.assertEqual(service['selector'], deployment['selector']['matchLabels'])
        self.assertFalse(any(x['kind'] == 'NetworkPolicy' and x['metadata']['name'] == name for x in items))
        pools = obj(items, 'ConfigMap', name + '-adb-pools')['data']['adb-pools.json']
        self.assertEqual(json.loads(pools), [
            {'provider': 'usb-provider', 'host': 'usb-adb', 'port': 5037, 'systemPorts': []},
            {'provider': 'farm-stf-android-remote', 'host': 'adb.example', 'port': 15037, 'systemPorts': []}])
        values['android']['providers'][1]['externalAdb']['port'] = 5037
        changed = obj(render(values, release='farm', namespace='test-farm'), 'Deployment', name)['spec']
        self.assertNotEqual(deployment['template']['metadata']['annotations']['checksum/adb-pools'],
                            changed['template']['metadata']['annotations']['checksum/adb-pools'])

    def test_coordinator_accepts_existing_state_and_explicit_upstreams(self):
        pools = [{'provider': 'old-provider', 'host': 'adb.other.svc', 'port': 5037, 'systemPorts': [8200]}]
        peers = [{'namespaceSelector': {'matchLabels': {'role': 'ingress'}},
                  'podSelector': {'matchLabels': {'app': 'controller'}}}]
        values = {
            'coordinator': {'enabled': True, 'existingSecret': 'credentials', 'projectTokensKey': 'projects',
                            'image': {'repository': 'registry.example/coordinator', 'tag': 'custom'},
                            'stfApiUrl': 'http://api.other.svc:7100/api/v1',
                            'appiumGridUrl': 'http://router.grid.svc:4444/wd/hub',
                            'publicUrl': 'https://coordinator.example', 'adbPools': pools,
                            'persistence': {'existingClaim': 'previous-lease-state'}},
            'image': {'digest': 'sha256:' + 'a' * 64},
            'networkPolicy': {'coordinatorFrom': peers}
        }
        items = render(values)
        name = 'stf-coordinator'
        pod = obj(items, 'Deployment', name)['spec']['template']['spec']
        self.assertNotIn('initContainers', pod)
        container = pod['containers'][0]
        self.assertEqual(container['image'], 'registry.example/coordinator:custom')
        self.assertIn('--stf-api-url=http://api.other.svc:7100/api/v1', container['args'])
        self.assertIn('--public-url=https://coordinator.example', container['args'])
        self.assertIn('--appium-grid-url=http://router.grid.svc:4444/wd/hub', container['args'])
        self.assertIn('--project-tokens-file=/secrets/projects.json', container['args'])
        self.assertIn({'name': 'state', 'persistentVolumeClaim': {'claimName': 'previous-lease-state'}}, pod['volumes'])
        self.assertFalse(any(x['kind'] == 'PersistentVolumeClaim' and x['metadata']['name'].startswith(name) for x in items))
        self.assertEqual(json.loads(obj(items, 'ConfigMap', name + '-adb-pools')['data']['adb-pools.json']), pools)
        policy = obj(items, 'NetworkPolicy', name)['spec']
        self.assertEqual(policy['podSelector']['matchLabels'], {
            'app.kubernetes.io/instance': 'stf', 'app.kubernetes.io/component': 'coordinator'})
        self.assertEqual(policy['ingress'], [{'from': peers, 'ports': [{'protocol': 'TCP', 'port': 'http'}]}])

    def test_invalid_coordinator_inputs_fail_before_install(self):
        provider = {'name': 'usb', 'nodeSelector': {'kubernetes.io/hostname': 'usb-a'}}
        pool = {'provider': 'android-a', 'host': 'adb.example', 'port': 5037, 'systemPorts': [8200]}
        for overrides, failure in [
            ({'existingSecret': ''}, 'coordinator.existingSecret'),
            ({'image': {'repository': 'registry.example/stf'}}, 'coordinator.image'),
            ({'stfApiUrl': 'https://user:secret@api.example'}, 'stfApiUrl'),
            ({'maxParallel': 0}, 'maxParallel'),
            ({'appiumGridUrl': 'http://grid.example:4444'}, 'coordinator.adbPools must be explicit'),
            ({'adbPools': [pool, {**pool, 'host': 'second.example'}]}, 'provider names must be unique'),
            ({'adbPools': [pool, {**pool, 'provider': 'android-b'}]}, 'systemPorts cannot overlap'),
        ]:
            with self.subTest(failure=failure):
                render({'android': {'providers': [provider]},
                        'coordinator': {'enabled': True, 'existingSecret': 'credentials', **overrides}},
                       failure=failure)

    def test_bundled_grid_limits_access_and_routes_each_device_to_its_relay(self):
        values = {
            'coordinator': {'enabled': True, 'existingSecret': 'leases'},
            'appium': {'enabled': True, 'image': {'repository': 'example.invalid/appium', 'tag': 'test'}},
            'android': {'providers': [
                {'name': 'usb', 'nodeSelector': {'kubernetes.io/hostname': 'usb-a'},
                 'appium': {'replicas': 2, 'systemPorts': [8200, 8201]}},
                {'name': 'maestro', 'externalAdb': {'host': 'adb.example'}}]},
            'ios': {'image': IOS_IMAGE, 'devices': [
                {**iphone(), 'appium': {'platformVersion': '26.7.1'}}]}
        }
        items = render(values)
        coordinator = obj(items, 'Deployment', 'stf-coordinator')['spec']['template']['spec']['containers'][0]
        self.assertIn('--appium-grid-url=http://stf-appium-grid:4444', coordinator['args'])
        grid = obj(items, 'Service', 'stf-appium-grid')['spec']
        self.assertEqual(grid['type'], 'ClusterIP')
        self.assertEqual({p['port'] for p in grid['ports']}, {4442, 4443, 4444})
        adb = obj(items, 'Service', 'stf-adb-usb')['spec']
        self.assertEqual({p['port'] for p in adb['ports']}, {5037, 8200, 8201})
        android = obj(items, 'Deployment', 'stf-appium-android-usb')['spec']
        self.assertEqual(android['replicas'], 2)
        appium = next(c for c in android['template']['spec']['containers'] if c['name'] == 'appium')
        self.assertEqual(appium['command'], ['sh', '-ec'])
        self.assertIn('node /opt/stf-appium/logcat-probe.mjs', appium['args'][0])
        self.assertIn('exec appium --address=127.0.0.1 --port=4723', appium['args'][0])
        self.assertIn(r'\"appium:skipLogcatCapture\":${skip_logcat}', appium['args'][0])
        self.assertIn({'name': 'appium-relay-config', 'mountPath': '/opt/stf-appium', 'readOnly': True},
                      appium['volumeMounts'])
        probe = obj(items, 'ConfigMap', 'stf-appium-android-usb')['data']['logcat-probe.mjs']
        self.assertEqual(probe.strip(), (CHART / 'files/appium/logcat-probe.mjs').read_text().strip())
        pools = json.loads(obj(items, 'ConfigMap', 'stf-coordinator-adb-pools')['data']['adb-pools.json'])
        self.assertEqual([p['systemPorts'] for p in pools], [[8200, 8201], []])
        for deployment, configmap, stereotype in [
            (android, 'stf-appium-android-usb',
             {'platformName': 'Android', 'appium:automationName': 'UiAutomator2',
              'appium:remoteAdbHost': 'stf-adb-usb', 'appium:adbPort': 5037}),
            (obj(items, 'Deployment', 'stf-ios-iphone-a')['spec'], 'stf-ios-iphone-a-appium',
             {'platformName': 'iOS', 'appium:automationName': 'XCUITest',
              'appium:udid': iphone()['udid'], 'appium:platformVersion': '26.7.1'})
        ]:
            pod = deployment['template']
            self.assertEqual(pod['metadata']['labels']['stf-appium-relay'], 'true')
            self.assertEqual(pod['spec']['nodeSelector']['kubernetes.io/arch'], 'amd64')
            self.assertFalse(pod['spec']['automountServiceAccountToken'])
            relay = next(c for c in pod['spec']['containers'] if c['name'] == 'relay')
            self.assertEqual(relay['args'], ['--host', '$(POD_IP)', '--hub', 'http://stf-appium-grid:4444',
                                             '--config', '/opt/stf-relay/node.toml'])
            config = obj(items, 'ConfigMap', configmap)['data']['node.toml'].splitlines()
            self.assertIn('url = "http://127.0.0.1:4723"', config)
            self.assertIn('max-sessions = 1', config)
            slots = json.loads(next(line for line in config if line.startswith('configs = '))[10:])
            self.assertEqual([slots[0], json.loads(slots[1])], ['1', stereotype])

        internal = obj(items, 'NetworkPolicy', 'stf-internal')['spec']['podSelector']
        self.assertEqual(internal['matchExpressions'], [
            {'key': 'app.kubernetes.io/component', 'operator': 'NotIn', 'values': ['appium-grid']},
            {'key': 'stf-appium-relay', 'operator': 'NotIn', 'values': ['true']}])
        hub = obj(items, 'NetworkPolicy', 'stf-appium-grid')['spec']['ingress']
        self.assertEqual(hub[0]['ports'], [{'protocol': 'TCP', 'port': 4444}])
        self.assertEqual(hub[0]['from'][0]['podSelector']['matchLabels']['app.kubernetes.io/component'],
                         'coordinator')
        relays = obj(items, 'NetworkPolicy', 'stf-appium-relays')['spec']['ingress']
        self.assertEqual([rule['ports'][0]['port'] for rule in relays], [6666, 17440])

    def test_bundled_grid_requires_explicit_compatible_runtime_and_slots(self):
        appium = {'enabled': True, 'image': {'repository': 'example.invalid/appium', 'tag': 'test'}}
        coordinator = {'enabled': True, 'existingSecret': 'leases'}
        render({'appium': appium}, failure='appium.enabled requires coordinator.enabled')
        render({'appium': {'enabled': True}, 'coordinator': coordinator}, failure='appium.image')
        render({'appium': appium, 'coordinator': coordinator}, failure='at least one provider or iPhone')
        render({'appium': appium,
                'coordinator': {**coordinator, 'appiumGridUrl': 'http://grid.example:4444'}},
               failure='mutually exclusive')
        render({'appium': appium, 'coordinator': coordinator,
                'android': {'providers': [
                    {'name': 'usb', 'nodeSelector': {'kubernetes.io/hostname': 'usb-a'},
                     'appium': {'replicas': 2, 'systemPorts': [8200]}}]}},
               failure='one systemPort per replica')

    def test_nondefault_namespace_and_resource_identity_overrides(self):
        values = {'fullnameOverride': 'custom', 'resourceNames': {'api': 'previous-api'},
                  'selectorOverrides': {'api': {'app': 'previous-api'}},
                  'networkPolicy': {'enabled': False}}
        items = render(values, namespace='another-ns', release='custom-release')
        api = obj(items, 'Deployment', 'previous-api')['spec']
        self.assertEqual(api['selector']['matchLabels'], {'app': 'previous-api'})
        self.assertEqual(api['template']['metadata']['labels'], {'app': 'previous-api'})
        binding = next(x for x in items if x['kind'] == 'RoleBinding')
        self.assertEqual(binding['subjects'][0]['namespace'], 'another-ns')
        self.assertNotIn('stf.svc.cluster.local', json.dumps(items))

    def test_migration_is_not_a_hook_and_gate_can_read_only_that_job(self):
        items = render()
        job = next(x for x in items if x['kind'] == 'Job')
        self.assertNotIn('helm.sh/hook', job['metadata'].get('annotations', {}))
        self.assertNotIn('ttlSecondsAfterFinished', job['spec'])
        role = next(x for x in items if x['kind'] == 'Role')
        self.assertEqual(role['rules'], [{'apiGroups': ['batch'], 'resources': ['jobs'],
            'resourceNames': [job['metadata']['name']], 'verbs': ['get']}])
        for x in items:
            if x['kind'] != 'Deployment': continue
            pod = x['spec']['template']['spec']
            self.assertFalse(pod['automountServiceAccountToken'])
            self.assertEqual(pod['initContainers'][0]['name'], 'wait-migration')
            for c in pod['containers']:
                self.assertFalse(any(v['name'] == 'migration-identity' for v in c.get('volumeMounts', [])))

    def test_upgrade_hash_is_stable_until_migration_payload_changes(self):
        def name(values=None, **kw): return next(x['metadata']['name'] for x in render(values, **kw) if x['kind'] == 'Job')
        self.assertEqual(name(), name(upgrade=True))
        for v in [{'image': {'tag': 'changed'}}, {'migration': {'revision': '2'}},
                  {'session': {'existingSecret': 'other'}}, {'bootstrap': {'adminEmail': 'other@example.com'}},
                  {'ports': {'http': 3100}}, {'resourceNames': {'rethinkdb': 'previous-db'}},
                  {'selectorOverrides': {'migrate': {'app.kubernetes.io/instance': 'stf',
                                                 'app': 'previous-migrate'}}}]:
            self.assertNotEqual(name(), name(v))

    def test_enabling_isolation_replaces_migration_job_without_changing_legacy_selectors(self):
        overrides = {'migrate': {'app': 'previous-migrate'}, 'api': {'app': 'previous-api'}}
        renders = [render({'selectorOverrides': overrides, 'networkPolicy': {'enabled': enabled}},
                          upgrade=True) for enabled in (False, True)]
        jobs = [next(x for x in items if x['kind'] == 'Job') for items in renders]
        self.assertNotEqual(jobs[0]['spec']['template']['metadata']['labels'],
                            jobs[1]['spec']['template']['metadata']['labels'])
        self.assertNotEqual(jobs[0]['metadata']['name'], jobs[1]['metadata']['name'])
        for items, job in zip(renders, jobs):
            api = obj(items, 'Deployment', 'stf-api')['spec']
            self.assertEqual(api['selector']['matchLabels'], overrides['api'])
            self.assertEqual(obj(items, 'Service', 'stf-api')['spec']['selector'], overrides['api'])
            barrier = api['template']['spec']['initContainers'][0]
            self.assertIn({'name': 'MIGRATION_JOB', 'value': job['metadata']['name']}, barrier['env'])
            role = next(x for x in items if x['kind'] == 'Role')
            self.assertEqual(role['rules'][0]['resourceNames'], [job['metadata']['name']])

    def test_default_migration_preserves_existing_admin_and_explicit_override_is_forwarded(self):
        def env(values=None):
            job = next(x for x in render(values) if x['kind'] == 'Job')
            return {x['name']: x.get('value') for x in job['spec']['template']['spec']['containers'][0]['env']}
        self.assertNotIn('STF_ADMIN_EMAIL', env())
        self.assertNotIn('STF_ADMIN_NAME', env())
        custom = env({'bootstrap': {'adminEmail': 'owner@example.test', 'adminName': 'Owner'}})
        self.assertEqual(custom['STF_ADMIN_EMAIL'], 'owner@example.test')
        self.assertEqual(custom['STF_ADMIN_NAME'], 'Owner')

    def test_long_adopted_migration_name_retains_revision_hash(self):
        def job(revision):
            values = {'resourceNames': {'migrate': 'm' * 63}, 'migration': {'revision': revision}}
            return next(x['metadata']['name'] for x in render(values) if x['kind'] == 'Job')
        self.assertEqual(len(job('a')), 63)
        self.assertNotEqual(job('a'), job('b'))

    def test_external_database_and_existing_claims(self):
        items = render({'database': {'bundled': False, 'external': {'host': 'db.example',
            'existingSecret': 'db-auth'}}, 'storage': {'persistence': {'enabled': True, 'existingClaim': 'existing-storage'}}})
        self.assertFalse(any(x['kind'] in ['StatefulSet', 'PersistentVolumeClaim'] for x in items))
        storage = obj(items, 'Deployment', 'stf-storage')['spec']['template']['spec']
        self.assertIn({'name': 'storage', 'persistentVolumeClaim': {'claimName': 'existing-storage'}}, storage['volumes'])
        env = obj(items, 'Deployment', 'stf-api')['spec']['template']['spec']['containers'][0]['env']
        self.assertIn({'name': 'RETHINKDB_PORT_28015_TCP', 'value': 'tcp://db.example:28015'}, env)
        self.assertTrue(any(e['name'] == 'RETHINKDB_ENV_AUTHKEY' and 'secretKeyRef' in e['valueFrom'] for e in env))

    def test_android_pools_reuse_ports_without_service_or_usb_aliasing(self):
        providers = [{'name': 'a', 'capacity': 2, 'nodeSelector': {'kubernetes.io/hostname': 'usb-a'}},
                     {'name': 'b', 'capacity': 2, 'nodeSelector': {'kubernetes.io/hostname': 'usb-b'}}]
        items = render({'android': {'providers': providers}})
        selectors = []
        for n in ['a', 'b']:
            service = obj(items, 'Service', 'stf-android-' + n)['spec']
            self.assertEqual([p['port'] for p in service['ports']], list(range(7400, 7408)))
            selectors.append(service['selector'])
            self.assertEqual(obj(items, 'Deployment', 'stf-adb-' + n)['spec']['strategy']['type'], 'Recreate')
        self.assertNotEqual(*selectors)
        proxy = obj(items, 'ConfigMap', 'stf-proxy')['data']['nginx.conf']
        self.assertIn('location = /d/stf-android-a/7400/', proxy)
        self.assertNotIn('location = /d/stf-android-a/7401/', proxy)
        self.assertNotIn('resolver 10.', proxy)
        providers[1]['nodeSelector'] = providers[0]['nodeSelector']
        render({'android': {'providers': providers}}, failure='one USB ADB server')
        providers[1]['nodeSelector'] = {**providers[0]['nodeSelector'], 'stf.role': 'android'}
        render({'android': {'providers': providers}}, failure='one USB ADB server')
        providers[1]['nodeSelector'] = {'stf.role': 'android'}
        render({'android': {'providers': providers}}, failure='explicit kubernetes.io/hostname')
        render({'android': {'providers': [{'name': 'a', 'capacity': 2, 'minPort': 65532, 'nodeSelector': {'n': 'a'}}]}}, failure='port pool')

    def test_android_install_fetches_via_complete_gateway_not_raw_storage(self):
        provider = {'name': 'a', 'externalAdb': {'host': 'adb'}}
        def storage(values):
            items = render(values)
            pod = obj(items, 'Deployment', 'stf-android-a')['spec']['template']['spec']
            return next(a for a in pod['containers'][0]['args'] if a.startswith('--storage-url='))
        self.assertEqual(storage({'android': {'providers': [provider]}}), '--storage-url=http://stf-proxy:7100/')
        provider['storageUrl'] = 'https://farm.example.com/'
        self.assertEqual(storage({'android': {'providers': [provider]}}), '--storage-url=https://farm.example.com/')

    def test_recreate_adoption_explicitly_clears_rolling_update(self):
        items = render({'android': {'providers': [{'name': 'a', 'nodeSelector': {'kubernetes.io/hostname': 'usb-a'}}]},
                        'ios': {'image': IOS_IMAGE, 'devices': [iphone()]}})
        for name in ['stf-storage', 'stf-android-a', 'stf-adb-a', 'stf-ios-iphone-a']:
            strategy = obj(items, 'Deployment', name)['spec']['strategy']
            self.assertEqual(strategy, {'type': 'Recreate', 'rollingUpdate': None})

    def test_shared_external_adb_requires_disjoint_serials(self):
        providers = [{'name': 'a', 'externalAdb': {'host': 'adb'}, 'serials': ['one']},
                     {'name': 'b', 'externalAdb': {'host': 'adb'}, 'serials': ['two']}]
        items = render({'android': {'providers': providers}})
        self.assertFalse(any(x['kind'] == 'Deployment' and x['metadata']['name'].startswith('stf-adb-') for x in items))
        providers[1]['serials'] = ['one']
        render({'android': {'providers': providers}}, failure='same serial')
        providers[1]['serials'] = []
        render({'android': {'providers': providers}}, failure='explicit disjoint')

    def test_multiple_iphones_have_private_state_and_healthy_offline_runtime(self):
        phones = [iphone(), iphone('iphone-b', '00008100-0000000000000002')]
        phones[0]['persistence'] = {'existingClaim': 'previous-iphone-state'}
        phones[0]['extraContainers'] = [{'name': 'optional-adapter', 'image': 'example.invalid/adapter:test'}]
        phones[1]['coreDevice'] = True
        items = render({'ios': {'image': IOS_IMAGE, 'devices': phones}})
        for p in phones:
            pod = obj(items, 'Deployment', 'stf-ios-' + p['name'])['spec']['template']['spec']
            cs = {c['name']: c for c in pod['containers']}
            self.assertTrue(cs['tunnel']['securityContext']['privileged'])
            self.assertFalse(cs['prototype']['securityContext']['allowPrivilegeEscalation'])
            self.assertEqual('--coredevice' in cs['prototype']['args'], p.get('coreDevice', False))
            health = json.dumps(cs['prototype']['readinessProbe'])
            self.assertIn('/health', health)
            self.assertNotIn('state', health)
            self.assertEqual(obj(items, 'Service', 'stf-ios-' + p['name'])['spec']['ports'],
                [{'name': 'screen', 'port': 17440, 'targetPort': 'screen'}])
        self.assertTrue(any(c['name'] == 'optional-adapter' for c in obj(items, 'Deployment', 'stf-ios-iphone-a')['spec']['template']['spec']['containers']))
        self.assertFalse(any(x['kind'] == 'PersistentVolumeClaim' and x['metadata']['name'] == 'stf-ios-iphone-a' for x in items))
        render({'ios': {'devices': [iphone()]}}, failure='ios.image')
        render({'ios': {'image': IOS_IMAGE, 'devices': [iphone(), iphone('b')]}}, failure='UDIDs must be unique')

    def test_interactive_ios_rollout_overrides_only_the_app_and_selected_phone(self):
        first = iphone()
        second = iphone('iphone-b', '00008100-0000000000000002')
        baseline = {'ios': {'image': IOS_IMAGE, 'devices': [first, second]}}
        app_image = {'repository': 'example.invalid/stf', 'digest': 'sha256:' + 'a' * 64}
        runtime_image = {'repository': 'example.invalid/ios-runtime', 'tag': 'pilot', 'pullPolicy': 'Always'}
        pilot = {**first, 'coreDevice': True, 'providerImage': app_image, 'prototypeImage': runtime_image}
        updated = {'core': {'units': {'app': {'image': app_image}}},
                   'ios': {'image': IOS_IMAGE, 'devices': [pilot, second]}}

        def manifests(values):
            return {(item['kind'], item['metadata']['name']): item for item in render(values)}

        before = manifests(baseline)
        after = manifests(updated)
        self.assertEqual(before.keys(), after.keys())
        self.assertEqual({key for key in before if before[key] != after[key]},
                         {('Deployment', 'stf-app'), ('Deployment', 'stf-ios-iphone-a')})
        app = after['Deployment', 'stf-app']['spec']['template']['spec']['containers'][0]
        app_digest = app_image['repository'] + '@' + app_image['digest']
        self.assertEqual(app['image'], app_digest)
        self.assertEqual(app['imagePullPolicy'], 'IfNotPresent')
        ios = after['Deployment', 'stf-ios-iphone-a']['spec']['template']['spec']
        old_ios = before['Deployment', 'stf-ios-iphone-a']['spec']['template']['spec']
        containers = {item['name']: item for item in ios['containers']}
        self.assertEqual(ios['initContainers'], old_ios['initContainers'])
        self.assertEqual(containers['tunnel'], next(c for c in old_ios['containers'] if c['name'] == 'tunnel'))
        self.assertEqual(containers['prototype']['image'], 'example.invalid/ios-runtime:pilot')
        self.assertEqual(containers['prototype']['imagePullPolicy'], 'Always')
        self.assertIn('--coredevice', containers['prototype']['args'])
        self.assertEqual(containers['stf-provider']['image'], app_digest)

    def test_image_overrides_require_a_complete_reference(self):
        render({'core': {'units': {'app': {'image': {'repository': 'example.invalid/stf'}}}}},
               failure='image')
        render({'ios': {'image': IOS_IMAGE, 'devices': [
            {**iphone(), 'prototypeImage': {'tag': 'pilot'}}]}}, failure='prototypeImage')
        render({'ios': {'image': IOS_IMAGE, 'devices': [
            {**iphone(), 'providerImage': {'repository': 'example.invalid/stf', 'digest': ''}}]}},
               failure='providerImage')

    def test_ingress_uses_public_origin_and_only_the_proxy(self):
        items = render({'publicOrigin': 'https://farm.example.com', 'proxy': {'ingress': {'enabled': True, 'className': 'custom'}}})
        ingress = next(x for x in items if x['kind'] == 'Ingress')['spec']
        self.assertEqual(ingress['rules'][0]['host'], 'farm.example.com')
        self.assertEqual(ingress['rules'][0]['http']['paths'][0]['backend']['service']['name'], 'stf-proxy')

    def test_configurable_http_and_separate_messaging_ports(self):
        values = {'ports': {'http': 3000}, 'messaging': {
            'app': {'pub': 7150, 'dealer': 7160, 'pull': 7170},
            'dev': {'pub': 7250, 'dealer': 7260, 'pull': 7270}},
            'proxy': {'containerPort': 8080, 'containerName': 'nginx',
                      'service': {'port': 8080}},
            'resourceNames': {'proxy-config': 'previous-screen-config'}}
        items = render(values)
        api = obj(items, 'Deployment', 'stf-api')['spec']['template']['spec']['containers'][0]
        self.assertIn({'name': 'PORT', 'value': '3000'}, api['env'])
        self.assertEqual(api['ports'], [{'name': 'http', 'containerPort': 3000}])
        self.assertIn('tcp://stf-triproxy-app:7150', api['command'])
        self.assertIn('tcp://stf-triproxy-app:7170', api['command'])
        self.assertIn('tcp://stf-triproxy-dev:7250', api['command'])
        self.assertIn('tcp://stf-triproxy-dev:7270', api['command'])
        for bus, expected in [('app', [7150, 7160, 7170]), ('dev', [7250, 7260, 7270])]:
            name = 'stf-triproxy-' + bus
            command = obj(items, 'Deployment', name)['spec']['template']['spec']['containers'][0]['command']
            for port in expected:
                self.assertIn('tcp://*:' + str(port), command)
            self.assertEqual([p['port'] for p in obj(items, 'Service', name)['spec']['ports']], expected)
        processor = obj(items, 'Deployment', 'stf-processor')['spec']['template']['spec']['containers'][0]
        self.assertIn('tcp://stf-triproxy-app:7160', processor['command'])
        self.assertIn('tcp://stf-triproxy-dev:7260', processor['command'])
        proxy = obj(items, 'Deployment', 'stf-proxy')['spec']['template']['spec']['containers'][0]
        self.assertEqual(proxy['name'], 'nginx')
        self.assertEqual(proxy['ports'], [{'name': 'http', 'containerPort': 8080}])
        self.assertEqual(obj(items, 'Service', 'stf-proxy')['spec']['ports'][0]['port'], 8080)
        config = obj(items, 'ConfigMap', 'previous-screen-config')['data']['nginx.conf']
        self.assertIn('listen 8080;', config)
        self.assertIn('server stf-api:3000;', config)
        first = next(x['metadata']['name'] for x in render() if x['kind'] == 'Job')
        changed = next(x['metadata']['name'] for x in items if x['kind'] == 'Job')
        self.assertNotEqual(first, changed)
        render({'messaging': {'app': {'pub': 7112}}}, failure='ports must be distinct')

    def test_exact_partial_android_pool_and_external_service(self):
        values = {'ports': {'http': 3000},
                  'messaging': {'dev': {'pub': 7250, 'dealer': 7260, 'pull': 7270}},
                  'android': {'providers': [{'name': 'a', 'containerName': 'previous-provider',
                      'minPort': 12010, 'maxPort': 12040, 'service': {'create': False},
                      'externalAdb': {'host': 'existing-adb'}}]}}
        items = render(values)
        self.assertFalse(any(x['kind'] == 'Service' and x['metadata']['name'] == 'stf-android-a' for x in items))
        container = obj(items, 'Deployment', 'stf-android-a')['spec']['template']['spec']['containers'][0]
        self.assertEqual(container['name'], 'previous-provider')
        self.assertIn('--max-port=12040', container['args'])
        self.assertIn('--connect-push=tcp://stf-triproxy-dev:7270', container['args'])
        self.assertIn('--storage-url=http://stf-proxy:7100/', container['args'])
        config = obj(items, 'ConfigMap', 'stf-proxy')['data']['nginx.conf']
        self.assertIn('/d/stf-android-a/12034/', config)
        self.assertNotIn('/d/stf-android-a/12038/', config)
        values['android']['providers'][0]['service']['create'] = True
        service = obj(render(values), 'Service', 'stf-android-a')['spec']
        self.assertEqual([p['port'] for p in service['ports']], list(range(12010, 12041)))
        values['android']['providers'][0]['maxPort'] = 12012
        render(values, failure='port pool')

    def test_disabled_migration_emits_no_api_access_or_bootstrap_job(self):
        phone = iphone()
        phone['service'] = {'create': False}
        values = {'migration': {'enabled': False},
                  'ios': {'image': IOS_IMAGE, 'devices': [phone]},
                  'android': {'providers': [{'name': 'a', 'externalAdb': {'host': 'existing-adb'}}]}}
        items = render(values)
        self.assertFalse(any(x['kind'] in ['Job', 'ServiceAccount', 'Role', 'RoleBinding'] for x in items))
        self.assertFalse(any(x['kind'] == 'Service' and x['metadata']['name'] == 'stf-ios-iphone-a' for x in items))
        for item in items:
            if item['kind'] != 'Deployment':
                continue
            pod = item['spec']['template']['spec']
            self.assertNotIn('serviceAccountName', pod)
            self.assertFalse(any(c['name'] == 'wait-migration' for c in pod.get('initContainers', [])))
            self.assertFalse(any(v['name'] == 'migration-identity' for v in pod.get('volumes', [])))
        ios = obj(items, 'Deployment', 'stf-ios-iphone-a')['spec']['template']['spec']
        self.assertEqual([c['name'] for c in ios['initContainers']], ['state'])

    def test_network_policy_isolates_every_release_pod_and_keeps_only_proxy_http_public(self):
        release = {'matchLabels': {'app.kubernetes.io/instance': 'stf'}}
        items = render()
        internal = obj(items, 'NetworkPolicy', 'stf-internal')['spec']
        self.assertEqual(internal['podSelector'], release)
        self.assertEqual(internal['policyTypes'], ['Ingress'])
        self.assertEqual(internal['ingress'], [{'from': [{'podSelector': release}]}])
        proxy = obj(items, 'NetworkPolicy', 'stf-proxy')['spec']
        self.assertEqual(proxy['podSelector'], {'matchLabels': {
            'app.kubernetes.io/instance': 'stf', 'app.kubernetes.io/component': 'proxy'}})
        self.assertEqual(proxy['policyTypes'], ['Ingress'])
        self.assertEqual(proxy['ingress'], [{'ports': [{'protocol': 'TCP', 'port': 'http'}]}])
        self.assertFalse(any(x['metadata']['name'] == 'stf-remote-providers' for x in items))
        with open(CHART / 'examples' / 'usb.yaml') as f:
            usb = yaml.safe_load(f)
        for scenario in (items, render(usb)):
            for x in scenario:
                if x['kind'] not in ('Deployment', 'StatefulSet', 'Job'):
                    continue
                labels = x['spec']['template']['metadata']['labels']
                role = 'migrate' if x['kind'] == 'Job' else x['metadata']['name'][4:]
                with self.subTest(kind=x['kind'], name=x['metadata']['name']):
                    self.assertEqual(labels['app.kubernetes.io/instance'], 'stf')
                    self.assertEqual(labels['app.kubernetes.io/component'], role)

    def test_network_policy_restricted_proxy_still_accepts_own_providers(self):
        release = {'podSelector': {'matchLabels': {'app.kubernetes.io/instance': 'stf'}}}
        ingress = {'namespaceSelector': {'matchLabels': {'kubernetes.io/metadata.name': 'ingress-nginx'}}}
        floor2 = {'namespaceSelector': {'matchLabels': {'kubernetes.io/metadata.name': 'stf-floor2'}}}
        items = render({'networkPolicy': {'proxyFrom': [ingress], 'remoteProvidersFrom': [floor2]},
                        'messaging': {'dev': {'pub': 7250, 'dealer': 7260, 'pull': 7270}},
                        'android': {'providers': [{'name': 'a', 'externalAdb': {'host': 'adb'}}]}})
        self.assertEqual(obj(items, 'NetworkPolicy', 'stf-proxy')['spec']['ingress'], [{
            'ports': [{'protocol': 'TCP', 'port': 'http'}], 'from': [release, ingress]}])
        self.assertEqual(obj(items, 'NetworkPolicy', 'stf-internal')['spec']['ingress'], [{'from': [release]}])
        provider = obj(items, 'Deployment', 'stf-android-a')['spec']['template']['spec']['containers'][0]
        self.assertIn('--storage-url=http://stf-proxy:7100/', provider['args'])
        remote = obj(items, 'NetworkPolicy', 'stf-remote-providers')['spec']
        self.assertEqual(remote['podSelector'], {'matchLabels': {
            'app.kubernetes.io/instance': 'stf', 'app.kubernetes.io/component': 'triproxy-dev'}})
        self.assertEqual(remote['policyTypes'], ['Ingress'])
        self.assertEqual(remote['ingress'], [{'ports': [{'protocol': 'TCP', 'port': 'pub'},
                                                      {'protocol': 'TCP', 'port': 'pull'}],
                                             'from': [floor2]}])
        bus = obj(items, 'Deployment', 'stf-triproxy-dev')['spec']['template']['spec']['containers'][0]
        self.assertEqual(bus['ports'], [{'name': 'pub', 'containerPort': 7250},
                                       {'name': 'dealer', 'containerPort': 7260},
                                       {'name': 'pull', 'containerPort': 7270}])

    def test_network_labels_preserve_legacy_selectors_for_adoption(self):
        roles = ['api', 'proxy', 'triproxy-dev', 'rethinkdb', 'android-a', 'adb-a', 'ios-iphone-a', 'migrate']
        overrides = {role: {'app': 'previous-' + role} for role in roles}
        values = {'fullnameOverride': 'custom', 'selectorOverrides': overrides,
                  'resourceNames': {'api': 'previous-api'},
                  'android': {'providers': [{'name': 'a', 'nodeSelector': {'kubernetes.io/hostname': 'usb-a'}}]},
                  'ios': {'image': IOS_IMAGE, 'devices': [iphone()]}}
        items = render(values, namespace='another-ns', release='custom-release')
        for role in roles:
            name = 'previous-api' if role == 'api' else 'custom-' + role
            kind = 'StatefulSet' if role == 'rethinkdb' else 'Deployment'
            item = next(x for x in items if x['kind'] == 'Job') if role == 'migrate' else obj(items, kind, name)
            spec = item['spec']
            with self.subTest(role=role):
                self.assertEqual(spec['template']['metadata']['labels'], {
                    **overrides[role], 'app.kubernetes.io/instance': 'custom-release',
                    'app.kubernetes.io/component': role})
                if role != 'migrate':
                    self.assertEqual(spec['selector']['matchLabels'], overrides[role])
                if role not in ('migrate',):
                    self.assertEqual(obj(items, 'Service', name)['spec']['selector'], overrides[role])
        self.assertEqual(obj(items, 'NetworkPolicy', 'custom-internal')['spec']['podSelector'], {
            'matchLabels': {'app.kubernetes.io/instance': 'custom-release'}})
        self.assertEqual(obj(items, 'NetworkPolicy', 'custom-proxy')['spec']['podSelector'], {'matchLabels': {
            'app.kubernetes.io/instance': 'custom-release', 'app.kubernetes.io/component': 'proxy'}})
        binding = next(x for x in items if x['kind'] == 'RoleBinding')
        self.assertEqual(binding['subjects'][0]['namespace'], 'another-ns')

    def test_broad_legacy_selectors_cannot_broaden_network_policy_targets(self):
        release = {'app.kubernetes.io/instance': 'stf'}
        peer = {'namespaceSelector': {'matchLabels': {'kubernetes.io/metadata.name': 'remote'}}}
        items = render({'selectorOverrides': {'proxy': release, 'triproxy-dev': release},
                        'networkPolicy': {'remoteProvidersFrom': [peer]}})
        for policy, role in [('stf-proxy', 'proxy'), ('stf-remote-providers', 'triproxy-dev')]:
            with self.subTest(policy=policy):
                selector = obj(items, 'NetworkPolicy', policy)['spec']['podSelector']['matchLabels']
                self.assertEqual(selector, {**release, 'app.kubernetes.io/component': role})
                api_labels = obj(items, 'Deployment', 'stf-api')['spec']['template']['metadata']['labels']
                self.assertFalse(all(api_labels.get(k) == v for k, v in selector.items()))

    def test_conflicting_network_identity_labels_fail_before_install(self):
        for role, labels in [('api', {'app.kubernetes.io/component': 'proxy'}),
                             ('proxy', {'app.kubernetes.io/component': 'api'}),
                             ('triproxy-dev', {'app.kubernetes.io/component': 'proxy'}),
                             ('api', {'app.kubernetes.io/instance': 'another-release'}),
                             ('migrate', {'app.kubernetes.io/instance': 'another-release'})]:
            with self.subTest(role=role, labels=labels):
                render({'selectorOverrides': {role: labels}}, failure='selectorOverrides')
        render({'selectorOverrides': {'api': {'app.kubernetes.io/instance': 'stf',
                                             'app.kubernetes.io/component': 'api', 'app': 'previous-api'}}})

    def test_disabled_network_policy_preserves_old_template_labels(self):
        overrides = {'api': {'app': 'previous-api'},
                     'proxy': {'app.kubernetes.io/instance': 'old-release'},
                     'migrate': {'app': 'previous-migrate'}}
        items = render({'selectorOverrides': overrides, 'networkPolicy': {'enabled': False}})
        self.assertFalse(any(x['kind'] == 'NetworkPolicy' for x in items))
        for role in ['api', 'proxy']:
            spec = obj(items, 'Deployment', 'stf-' + role)['spec']
            self.assertEqual(spec['selector']['matchLabels'], overrides[role])
            self.assertEqual(spec['template']['metadata']['labels'], overrides[role])
        job = next(x for x in items if x['kind'] == 'Job')
        self.assertEqual(job['spec']['template']['metadata']['labels'], overrides['migrate'])

    def test_network_policy_accepts_selector_and_ip_peers(self):
        peers = [{'podSelector': {}}, {'namespaceSelector': {}},
                 {'namespaceSelector': {'matchLabels': {'environment': 'test'}},
                  'podSelector': {'matchExpressions': [
                      {'key': 'role', 'operator': 'In', 'values': ['provider']},
                      {'key': 'blocked', 'operator': 'NotIn', 'values': ['true']},
                      {'key': 'approved', 'operator': 'Exists'},
                      {'key': 'quarantine', 'operator': 'DoesNotExist', 'values': []}]}},
                 {'ipBlock': {'cidr': '192.0.2.0/24', 'except': ['192.0.2.128/25']}},
                 {'ipBlock': {'cidr': '2001:db8::/32'}}]
        items = render({'networkPolicy': {'proxyFrom': peers, 'remoteProvidersFrom': peers}})
        self.assertEqual(obj(items, 'NetworkPolicy', 'stf-proxy')['spec']['ingress'][0]['from'][1:], peers)
        self.assertEqual(obj(items, 'NetworkPolicy', 'stf-remote-providers')['spec']['ingress'][0]['from'], peers)

    def test_invalid_network_policy_peers_fail_schema_validation(self):
        invalid = [{}, {'unknown': {}}, {'podSelector': {'unknown': True}},
                   {'namespaceSelector': {'matchLabels': {'role': 1}}},
                   {'ipBlock': {'cidr': '192.0.2.0/24'}, 'podSelector': {}},
                   {'ipBlock': {'cidr': '192.0.2.0/24'}, 'namespaceSelector': {}},
                   {'ipBlock': {}}, {'ipBlock': {'cidr': '192.0.2.0/24', 'except': [7]}},
                   {'podSelector': {'matchExpressions': [{}]}},
                   {'podSelector': {'matchExpressions': [{'key': 'role'}]}},
                   {'podSelector': {'matchExpressions': [{'key': 'role', 'operator': 'Unknown'}]}},
                   {'podSelector': {'matchExpressions': [{'key': 'role', 'operator': 'In'}]}},
                   {'podSelector': {'matchExpressions': [{'key': 'role', 'operator': 'NotIn', 'values': []}]}},
                   {'namespaceSelector': {'matchExpressions': [{'key': 'role', 'operator': 'Exists', 'values': ['x']}]}},
                   {'namespaceSelector': {'matchExpressions': [{'key': 'role', 'operator': 'DoesNotExist', 'values': ['x']}]}},
                   {'namespaceSelector': {'matchExpressions': [{'key': 'role', 'operator': 'Exists', 'unknown': True}]}}]
        for setting in ['proxyFrom', 'remoteProvidersFrom', 'coordinatorFrom']:
            for peer in invalid:
                with self.subTest(setting=setting, peer=peer):
                    render({'networkPolicy': {setting: [peer]}}, failure=setting)

    def test_public_usb_example_uses_oauth_and_confines_its_secret_to_auth(self):
        with open(CHART / 'examples' / 'usb.yaml') as f:
            values = yaml.safe_load(f)
        self.assertTrue(values['proxy']['ingress']['enabled'])
        self.assertEqual(values['auth']['type'], 'oauth2')
        self.assertEqual(values['auth']['existingSecret'], 'stf-oauth')
        items = render(values)
        auth = obj(items, 'Deployment', 'stf-auth')['spec']['template']['spec']['containers'][0]
        self.assertEqual(auth['command'], ['stf', 'auth-oauth2', '--app-url', values['publicOrigin'] + '/'])
        self.assertEqual(auth['envFrom'], [{'secretRef': {'name': 'stf-oauth'}}])
        auth_env = {e['name']: e.get('value') for e in auth['env']}
        self.assertEqual(auth_env['STF_AUTH_OAUTH2_OAUTH_CALLBACK_URL'],
                         values['publicOrigin'] + '/auth/oauth/callback')
        for key, value in values['auth']['env'].items():
            self.assertEqual(auth_env[key], value)
        self.assertNotIn('STF_AUTH_OAUTH2_OAUTH_CLIENT_ID', auth_env)
        self.assertNotIn('STF_AUTH_OAUTH2_OAUTH_CLIENT_SECRET', auth_env)
        app = obj(items, 'Deployment', 'stf-app')['spec']['template']['spec']['containers'][0]
        self.assertIn(values['publicOrigin'] + '/auth/oauth/', app['command'])
        self.assertFalse(any(x['kind'] == 'Secret' for x in items))
        for item in items:
            if item['kind'] not in ('Deployment', 'StatefulSet', 'Job'):
                continue
            for container in item['spec']['template']['spec']['containers']:
                if item['metadata']['name'] == 'stf-auth':
                    continue
                self.assertNotIn('stf-oauth', json.dumps(container))
                self.assertFalse(any(e['name'].startswith('STF_AUTH_OAUTH2_') for e in container.get('env', [])))

    def test_external_iphone_routes_are_explicit_screen_only_routes(self):
        route = {'path': '/d/existing-iphone-screen/17440/',
                 'service': 'existing-iphone-screen', 'port': 17440}
        items = render({'proxy': {'extraScreenRoutes': [route]}})
        config = obj(items, 'ConfigMap', 'stf-proxy')['data']['nginx.conf']
        self.assertIn('location = /d/existing-iphone-screen/17440/ { proxy_pass http://existing-iphone-screen:17440/; }', config)
        self.assertFalse(any(x['kind'] == 'Deployment' and 'ios-' in x['metadata']['name'] for x in items))
        render({'proxy': {'extraScreenRoutes': [route, route]}}, failure='paths must be unique')
        for invalid in [{'path': '/d/existing-iphone-screen/8100/', 'service': route['service'], 'port': 8100},
                        {**route, 'service': 'http://outside.example'}, {**route, 'path': '/api/v1/'}]:
            render({'proxy': {'extraScreenRoutes': [invalid]}}, failure='extraScreenRoutes')


if __name__ == '__main__': unittest.main()
