import os
import pathlib
import subprocess
import json
import sys
import tempfile
import unittest


class RuntimeConflictCheck(unittest.TestCase):
    def run_check(self, inventory, exit_code=0):
        installer = (pathlib.Path(__file__).parents[2] / 'deploy/install.sh').read_text()
        check = installer.split('  installed_packages=', 1)[1].split('  apt-get update', 1)[0]
        # The function receives fixture data through environment variables;
        # it replaces only the read-only package query, never invokes apt or Docker.
        script = 'set -euo pipefail\ndpkg-query() { printf "%s\\n" "$INVENTORY"; return "$QUERY_EXIT"; }\n'
        script += '  installed_packages=' + check + '\necho READY\n'
        return subprocess.run(['bash', '-c', script], env={**os.environ, 'INVENTORY': inventory, 'QUERY_EXIT': str(exit_code)}, capture_output=True, text=True)

    def test_each_conflicting_package_blocks_before_installation(self):
        for name in ('docker.io', 'containerd', 'runc:amd64'):
            with self.subTest(name=name):
                result = self.run_check(f'{name} install ok installed\nother install ok installed')
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn('READY', result.stdout)

    def test_removed_packages_do_not_block(self):
        result = self.run_check('runc deinstall ok config-files\nother install ok installed')
        self.assertEqual(result.returncode, 0)
        self.assertIn('READY', result.stdout)

    def test_query_failure_stops_before_installation(self):
        result = self.run_check('', exit_code=1)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('READY', result.stdout)


class InstallationMetadata(unittest.TestCase):
    def run_installer(self, args=(), metadata=True, stdin=''):
        source = (pathlib.Path(__file__).parents[2] / 'deploy/install.sh').read_text()
        # Execute the real argument/default selection with only the host mutation
        # section omitted. The final Python process records arguments, not installs.
        script = source.split('[[ ${EUID}', 1)[0]
        script += source[source.index('if [[ -z "$release_version"'):]
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp).resolve()
            (root / 'deploy').mkdir()
            installer = root / 'deploy/install.sh'
            installer.write_text(script)
            if metadata:
                (root / 'package.json').write_text(json.dumps({'version': '0.2.1'}))
                (root / 'deploy/release-public.pub').write_text('public fixture')
            (root / 'bin').mkdir()
            python = root / 'bin/python3'
            python.write_text(f'#!{sys.executable}\nimport sys,os,json\nif sys.argv[1]=="-c": os.execv(sys.executable,[sys.executable,*sys.argv[1:]])\nprint("ARGS="+json.dumps(sys.argv[1:]))\n')
            python.chmod(0o755)
            result = subprocess.run(['bash', str(installer), *args], input=stdin,
                env={**os.environ, 'PATH': str(root / 'bin') + os.pathsep + os.environ['PATH']},
                capture_output=True, text=True)
            recorded = [line[5:] for line in result.stdout.splitlines() if line.startswith('ARGS=')]
            return result, json.loads(recorded[0]) if recorded else None, str(root)

    def test_repository_defaults_need_no_version_or_key_prompt(self):
        result, args, root = self.run_installer()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(args, [root+'/deploy/updater.py', 'install', '--version', '0.2.1', '--public-key', root+'/deploy/release-public.pub'])

    def test_explicit_options_override_repository_metadata(self):
        result, args, _ = self.run_installer(('--version', '0.3.0', '--public-key', '/trusted keys/release.pub'))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(args[-4:], ['--version', '0.3.0', '--public-key', '/trusted keys/release.pub'])

    def test_legacy_bundle_retains_interactive_fallback(self):
        result, args, _ = self.run_installer(metadata=False, stdin='0.2.0\n/trusted/release.pub\n')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(args[-4:], ['--version', '0.2.0', '--public-key', '/trusted/release.pub'])

    def test_invalid_options_stop_before_installer_execution(self):
        for options in (('--unknown',), ('--version',), ('--public-key', '')):
            result, args, _ = self.run_installer(options)
            self.assertNotEqual(result.returncode, 0)
            self.assertIsNone(args)
