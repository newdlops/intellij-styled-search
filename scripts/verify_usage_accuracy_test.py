import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from verify_usage_accuracy import verify_dump, verify_semantics, lexical_frequency, DEFAULT_EXCLUDES


class UsageVerificationTests(unittest.TestCase):
    def test_declaration_location_selects_among_same_named_lexical_bindings(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            expected = root / "expected.json"
            item = {"query": "work", "relPath": "source.js", "declarationLine": 0, "locations": []}
            expected.write_text(json.dumps({"version": 1, "symbols": [item]}))
            symbols = {"symbols": [
                {"qualifiedName": "work", "relPath": "source.js", "id": "sym:1", "usageCount": 0,
                 "range": {"startLine": 0}},
                {"qualifiedName": "work", "relPath": "source.js", "id": "sym:2", "usageCount": 3,
                 "range": {"startLine": 5}},
            ]}
            with patch("verify_usage_accuracy.run_query", side_effect=[symbols, {"totalReferences": 0, "references": []}]) as query, contextlib.redirect_stdout(io.StringIO()):
                self.assertTrue(verify_semantics(root, expected, "unused-binary"))
            self.assertIn("sym:1", query.call_args.args)
            del item["declarationLine"]
            expected.write_text(json.dumps({"version": 1, "symbols": [item]}))
            with patch("verify_usage_accuracy.run_query", return_value=symbols), contextlib.redirect_stdout(io.StringIO()):
                self.assertFalse(verify_semantics(root, expected, "unused-binary"))

    def test_possible_references_cannot_hide_forbidden_semantic_locations(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            expected = root / "expected.json"
            expected.write_text(json.dumps({"version": 1, "symbols": [{
                "query": "work", "relPath": "source.py", "locations": [],
                "forbiddenLocations": [["consumer.py", 1, 4]],
            }]}))
            symbols = {"symbols": [{"qualifiedName": "work", "relPath": "source.py", "id": "sym:1", "usageCount": 1}]}
            refs = {"totalReferences": 1, "references": [{"confidence": "possible", "relPath": "consumer.py",
                    "range": {"startLine": 1, "startColumn": 4}}]}
            with patch("verify_usage_accuracy.run_query", side_effect=[symbols, refs]), contextlib.redirect_stdout(io.StringIO()):
                self.assertFalse(verify_semantics(root, expected, "unused-binary"))

    def test_required_defaults_are_checked_before_call_filtering(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            expected = root / "expected.json"
            expected.write_text(json.dumps({"version": 1, "symbols": [{
                "query": "work", "relPath": "source.py", "edgeKinds": ["call"], "locations": [],
                "requiredLocations": [["consumer.py", 0, 10]],
            }]}))
            symbol = {"qualifiedName": "work", "relPath": "source.py", "id": "sym:1", "usageCount": 1}
            refs = {"totalReferences": 1, "references": [{"confidence": "exact", "edgeKind": "usage",
                    "relPath": "consumer.py", "range": {"startLine": 0, "startColumn": 10}}]}
            with patch("verify_usage_accuracy.run_query", side_effect=[{"symbols": [symbol]}, refs]), contextlib.redirect_stdout(io.StringIO()):
                self.assertTrue(verify_semantics(root, expected, "unused-binary"))
            symbol["usageCount"] = 0
            with patch("verify_usage_accuracy.run_query", side_effect=[{"symbols": [symbol]}, {"totalReferences": 0, "references": []}]), contextlib.redirect_stdout(io.StringIO()):
                self.assertFalse(verify_semantics(root, expected, "unused-binary"))

    def test_name_frequency_cannot_override_real_count_list_parity(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "source.py").write_text(
                "def original(): pass\nalias = original\n" + "alias()\n" * 8 +
                "def unused(): pass\n" + "# unused\n" * 8 + "def 작업(): pass\n작업()\n", encoding="utf-8")
            dump = root / "live.tsv"
            dump.write_text("relPath\tname\tusageCount\tqueryable\n"
                            "source.py\toriginal\t9\t9\nsource.py\tunused\t0\t0\nsource.py\t작업\t1\t1\n", encoding="utf-8")
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                self.assertTrue(verify_dump(root, dump, DEFAULT_EXCLUDES))
            self.assertEqual(json.loads(output.getvalue())["mismatches"], 0)
            self.assertEqual(lexical_frequency(root)["작업"], 2)

    def test_parity_mismatch_fails_and_legacy_static_dump_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            dump = root / "live.tsv"
            dump.write_text("relPath\tname\tusageCount\tqueryable\nx.py\twork\t2\t1\n")
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertFalse(verify_dump(root, dump, DEFAULT_EXCLUDES))
            dump.write_text("relPath\tname\tusageLikely\temitted\nx.py\twork\t2\t1\n")
            with self.assertRaises(ValueError):
                verify_dump(root, dump, DEFAULT_EXCLUDES)


if __name__ == "__main__":
    unittest.main()
