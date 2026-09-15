import os
import pathlib
import subprocess
import unittest


class RuntimeConflictCheck(unittest.TestCase):
    def run_check(self, inventory, exit_code=0):
        installer = (pathlib.Path(__file__).parents[2] / 'deploy/install.sh').read_text()
        check = installer.split('  installed_packages=', 1)[1].split('  apt-get update', 1)[0]
        # The function receives fixture data through positional shell parameters;
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
