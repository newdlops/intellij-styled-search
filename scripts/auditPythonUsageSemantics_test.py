import tempfile
from pathlib import Path
import unittest
from auditPythonUsageSemantics import Oracle


class ScopeOracleTests(unittest.TestCase):
    def oracle(self, files):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        for name, text in files.items():
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding='utf-8')
        return Oracle(root)

    def test_import_aliases_and_module_receivers_use_the_declaring_module(self):
        oracle = self.oracle({
            'pkg/provider.py': 'def action():\n    pass\n',
            'pkg/consumer.py': 'from .provider import action as invoke\nimport pkg.provider as service\ninvoke()\nservice.action()\ndef local(invoke, service):\n    invoke()\n    service.action()\n',
        })
        self.assertEqual(oracle.required[('pkg/provider.py', 'action')],
                         {('pkg/consumer.py', 2, 0), ('pkg/consumer.py', 3, 8)})

    def test_defaults_captures_explicit_globals_and_comprehension_bindings(self):
        oracle = self.oracle({'scope.py':
            'def action():\n    pass\n'
            'def outer(action=action):\n'
            '    def nested():\n        return action()\n'
            '    return [action() for action in []]\n'
            'def explicit():\n    global action\n    return action()\n'
            'value = (lambda action: action())\n'})
        self.assertEqual(oracle.required[('scope.py', 'action')],
                         {('scope.py', 2, 17), ('scope.py', 8, 11)})
        self.assertEqual(oracle.local_names[('scope.py', 4, 15)], 'action')
        self.assertEqual(oracle.local_names[('scope.py', 5, 12)], 'action')
        self.assertEqual(oracle.local_names[('scope.py', 9, 24)], 'action')

    def test_reassigned_module_declarations_are_unclassified(self):
        oracle = self.oracle({'source.py':
            'def action():\n    pass\n'
            'action, other = (None, None)\n'
            'action()\n'})
        self.assertNotIn(('source.py', 'action'), oracle.targets)

    def test_comprehension_locals_do_not_leak_and_nested_lambdas_capture_them(self):
        oracle = self.oracle({'scope.py':
            'def action():\n    pass\n'
            'def outer():\n'
            '    values = [action() for action in action()]\n'
            '    deferred = [(lambda: action()) for action in []]\n'
            '    return action()\n'})
        self.assertEqual(oracle.required[('scope.py', 'action')],
                         {('scope.py', 3, 37), ('scope.py', 5, 11)})
        self.assertEqual(oracle.local_names[('scope.py', 3, 14)], 'action')
        self.assertEqual(oracle.local_names[('scope.py', 4, 25)], 'action')

    def test_unicode_ast_bytes_are_converted_to_utf16_columns(self):
        oracle = self.oracle({'unicode.py':
            'def action():\n    pass\n'
            'text = "🙂"; action()\n'})
        self.assertEqual(oracle.required[('unicode.py', 'action')], {('unicode.py', 2, 13)})


if __name__ == '__main__':
    unittest.main()
