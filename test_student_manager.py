import copy
import json
import math
import os
import tempfile
import unittest
from unittest import mock

import student_manager as sm
from student_manager import (
    DataFileError, SaveError, StudentStore, ValidationError,
    grade_for, validate_mark, validate_name, validate_roll, validate_subject,
)


class ValidationTests(unittest.TestCase):
    def test_roll_accepts_positive_whole_numbers(self):
        self.assertEqual(validate_roll(1), 1)
        self.assertEqual(validate_roll("12"), 12)
        self.assertEqual(validate_roll(" 7 "), 7)
        self.assertEqual(validate_roll(3.0), 3)

    def test_roll_rejects_invalid_values(self):
        for bad in [0, -1, "0", "-4", "abc", "", "1.5", 1.5, True, None, math.nan, math.inf, [1]]:
            with self.subTest(value=bad):
                with self.assertRaises(ValidationError):
                    validate_roll(bad)

    def test_name_accepts_normal_names_and_trims_spaces(self):
        self.assertEqual(validate_name("  Asha   Rao "), "Asha Rao")
        self.assertEqual(validate_name("O'Brien"), "O'Brien")
        self.assertEqual(validate_name("Jean-Luc"), "Jean-Luc")
        self.assertEqual(validate_name("Dr. Ann"), "Dr. Ann")

    def test_name_rejects_invalid_names(self):
        bad_names = ["", "   ", "A" * 61, "123", "Bob2", "<script>", "_x", None, 5]
        for bad in bad_names:
            with self.subTest(value=bad):
                with self.assertRaises(ValidationError):
                    validate_name(bad)

    def test_name_length_limit_is_inclusive(self):
        self.assertEqual(len(validate_name("A" * 60)), 60)

    def test_mark_accepts_range_and_text_numbers(self):
        self.assertEqual(validate_mark(0), 0.0)
        self.assertEqual(validate_mark(100), 100.0)
        self.assertEqual(validate_mark("85"), 85.0)
        self.assertEqual(validate_mark("72.5"), 72.5)

    def test_mark_rejects_out_of_range_and_non_finite(self):
        bad_marks = [-1, 100.01, 101, "nan", "inf", "-inf", math.nan, math.inf, -math.inf, True, "abc", "", None, [50]]
        for bad in bad_marks:
            with self.subTest(value=bad):
                with self.assertRaises(ValidationError):
                    validate_mark(bad)

    def test_subject_rules(self):
        self.assertEqual(validate_subject("  Maths "), "Maths")
        with self.assertRaises(ValidationError):
            validate_subject("   ")
        with self.assertRaises(ValidationError):
            validate_subject("x" * 41)

    def test_grade_boundaries(self):
        self.assertEqual(grade_for(80), "A")
        self.assertEqual(grade_for(79.99), "B")
        self.assertEqual(grade_for(70), "B")
        self.assertEqual(grade_for(69.99), "C")
        self.assertEqual(grade_for(60), "C")
        self.assertEqual(grade_for(50), "D")
        self.assertEqual(grade_for(49.99), "F")
        self.assertEqual(grade_for(0), "F")
        self.assertEqual(grade_for(None), "No marks yet")


class StoreTestCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = self._tmp.name
        self.path = os.path.join(self.dir, "students.json")
        self.store = StudentStore(self.path)
        self.store.load()

    def tearDown(self):
        self._tmp.cleanup()

    def reload(self):
        s = StudentStore(self.path)
        s.load()
        return s

    def file_text(self):
        with open(self.path, "r", encoding="utf-8") as f:
            return f.read()


class OperationTests(StoreTestCase):
    def test_add_student_saves_and_reloads(self):
        self.store.add_student("1", "Asha Rao", {"Maths": "90", "Science": 80})
        self.assertEqual(len(self.store.students), 1)
        again = self.reload()
        self.assertEqual(again.get(1)["name"], "Asha Rao")
        self.assertEqual(again.get(1)["marks"], {"Maths": 90.0, "Science": 80.0})

    def test_add_duplicate_roll_is_rejected_and_memory_unchanged(self):
        self.store.add_student(5, "Ravi")
        before = copy.deepcopy(self.store.students)
        with self.assertRaises(ValidationError):
            self.store.add_student("5", "Someone Else")
        self.assertEqual(self.store.students, before)

    def test_add_with_invalid_mark_is_rejected_and_nothing_added(self):
        with self.assertRaises(ValidationError):
            self.store.add_student(2, "Meena", {"Maths": 150})
        self.assertEqual(self.store.students, [])
        self.assertFalse(os.path.exists(self.path))

    def test_search_by_roll_name_and_no_match(self):
        self.store.add_student(1, "Asha Rao")
        self.store.add_student(2, "Ravi Kumar")
        self.assertEqual([s["roll"] for s in self.store.search("2")], [2])
        self.assertEqual([s["roll"] for s in self.store.search("asha")], [1])
        self.assertEqual([s["roll"] for s in self.store.search("KUMAR")], [2])
        self.assertEqual(self.store.search("zzz"), [])

    def test_search_empty_query_is_rejected(self):
        with self.assertRaises(ValidationError):
            self.store.search("   ")

    def test_search_returns_copies(self):
        self.store.add_student(1, "Asha")
        self.store.search("1")[0]["name"] = "Changed"
        self.assertEqual(self.store.get(1)["name"], "Asha")

    def test_update_name_success_and_invalid_name_leaves_data_unchanged(self):
        self.store.add_student(1, "Asha")
        self.store.update_name("1", "  Asha   Iyer ")
        self.assertEqual(self.reload().get(1)["name"], "Asha Iyer")
        before_text = self.file_text()
        with self.assertRaises(ValidationError):
            self.store.update_name(1, "R2D2")
        self.assertEqual(self.store.get(1)["name"], "Asha Iyer")
        self.assertEqual(self.file_text(), before_text)

    def test_update_name_for_missing_roll(self):
        with self.assertRaises(ValidationError):
            self.store.update_name(9, "Nobody")

    def test_update_roll_success_and_conflicts(self):
        self.store.add_student(1, "Asha")
        self.store.add_student(2, "Ravi")
        with self.assertRaises(ValidationError):
            self.store.update_roll(1, 2)
        self.store.update_roll(1, 1)  # same roll is fine
        self.store.update_roll(1, 3)
        self.assertEqual(self.reload().get(3)["name"], "Asha")
        with self.assertRaises(ValidationError):
            self.store.update_roll(3, 0)
        with self.assertRaises(ValidationError):
            self.store.update_roll(99, 100)

    def test_set_mark_add_overwrite_and_reject(self):
        self.store.add_student(1, "Asha")
        self.store.set_mark(1, "Maths", "70")
        self.store.set_mark(1, "Maths", 88)
        self.assertEqual(self.reload().get(1)["marks"]["Maths"], 88.0)
        with self.assertRaises(ValidationError):
            self.store.set_mark(1, "Maths", float("nan"))
        with self.assertRaises(ValidationError):
            self.store.set_mark(1, "Maths", -5)
        self.assertEqual(self.store.get(1)["marks"]["Maths"], 88.0)

    def test_average_and_grade(self):
        self.store.add_student(1, "Asha", {"Maths": 90, "Science": 70})
        self.assertEqual(self.store.average(1), 80.0)
        self.assertEqual(self.store.grade(1), "A")
        self.store.add_student(2, "Ravi")
        self.assertIsNone(self.store.average(2))
        self.assertEqual(self.store.grade(2), "No marks yet")

    def test_average_grade_across_bands(self):
        self.store.add_student(1, "A Student", {"x": 60, "y": 62})
        self.assertEqual(self.store.grade(1), "C")
        self.store.add_student(2, "F Student", {"x": 10, "y": 20})
        self.assertEqual(self.store.grade(2), "F")

    def test_delete_success_and_missing(self):
        self.store.add_student(1, "Asha")
        self.store.add_student(2, "Ravi")
        self.store.delete(1)
        self.assertEqual([s["roll"] for s in self.reload().students], [2])
        with self.assertRaises(ValidationError):
            self.store.delete(1)

    def test_get_missing_student(self):
        with self.assertRaises(ValidationError):
            self.store.get(42)


class LoadTests(StoreTestCase):
    def write(self, text):
        with open(self.path, "w", encoding="utf-8") as f:
            f.write(text)

    def test_missing_file_means_no_students(self):
        self.assertEqual(self.store.students, [])

    def test_corrupted_json_raises_and_file_is_untouched(self):
        self.write('{"version": 1, "students": [')
        before = self.file_text()
        s = StudentStore(self.path)
        with self.assertRaises(DataFileError):
            s.load()
        self.assertEqual(self.file_text(), before)

    def test_structure_problems_are_reported(self):
        good_student = {"roll": 1, "name": "Asha", "marks": {"Maths": 90}}
        cases = {
            "top level is a list": [],
            "missing version": {"students": []},
            "wrong version": {"version": 99, "students": []},
            "students not a list": {"version": 1, "students": {}},
            "student not an object": {"version": 1, "students": [5]},
            "bad roll": {"version": 1, "students": [dict(good_student, roll=0)]},
            "bad name": {"version": 1, "students": [dict(good_student, name="R2D2")]},
            "marks not an object": {"version": 1, "students": [dict(good_student, marks=[90])]},
            "mark out of range": {"version": 1, "students": [dict(good_student, marks={"Maths": 150})]},
            "mark not finite": {"version": 1, "students": [dict(good_student, marks={"Maths": "nan"})]},
            "duplicate roll": {"version": 1, "students": [good_student, dict(good_student, name="Ravi")]},
        }
        for label, data in cases.items():
            with self.subTest(case=label):
                self.write(json.dumps(data))
                before = self.file_text()
                with self.assertRaises(DataFileError):
                    StudentStore(self.path).load()
                self.assertEqual(self.file_text(), before)

    def test_valid_file_loads_and_is_cleaned(self):
        self.write(json.dumps({"version": 1, "students": [{"roll": "3", "name": "  Meena  Das ", "marks": {"Maths": "77"}}]}))
        s = StudentStore(self.path)
        s.load()
        self.assertEqual(s.get(3), {"roll": 3, "name": "Meena Das", "marks": {"Maths": 77.0}})


class SaveFailureTests(StoreTestCase):
    """A failed save must not change memory or the file on disk."""

    def setUp(self):
        super().setUp()
        self.store.add_student(1, "Asha", {"Maths": 90})
        self.saved_text = self.file_text()
        self.memory = copy.deepcopy(self.store.students)

    def fail_replace(self):
        return mock.patch("student_manager.os.replace", side_effect=OSError("disk full"))

    def assert_unchanged(self):
        self.assertEqual(self.store.students, self.memory)
        self.assertEqual(self.file_text(), self.saved_text)
        leftovers = [n for n in os.listdir(self.dir) if n.endswith(".tmp")]
        self.assertEqual(leftovers, [])

    def test_add_failure(self):
        with self.fail_replace(), self.assertRaises(SaveError):
            self.store.add_student(2, "Ravi")
        self.assert_unchanged()

    def test_update_name_failure(self):
        with self.fail_replace(), self.assertRaises(SaveError):
            self.store.update_name(1, "Asha Iyer")
        self.assert_unchanged()

    def test_update_roll_failure(self):
        with self.fail_replace(), self.assertRaises(SaveError):
            self.store.update_roll(1, 5)
        self.assert_unchanged()

    def test_set_mark_failure(self):
        with self.fail_replace(), self.assertRaises(SaveError):
            self.store.set_mark(1, "Maths", 40)
        self.assert_unchanged()

    def test_delete_failure(self):
        with self.fail_replace(), self.assertRaises(SaveError):
            self.store.delete(1)
        self.assert_unchanged()

    def test_failure_message_says_data_unchanged(self):
        with self.fail_replace():
            with self.assertRaises(SaveError) as ctx:
                self.store.delete(1)
        self.assertIn("unchanged", str(ctx.exception))

    def test_successful_save_writes_valid_json(self):
        self.store.set_mark(1, "Science", 75)
        data = json.loads(self.file_text())
        self.assertEqual(data["version"], sm.SCHEMA_VERSION)
        self.assertEqual(data["students"][0]["marks"], {"Maths": 90.0, "Science": 75.0})


class CliTests(StoreTestCase):
    def run_cli(self, answers):
        inputs = iter(answers)
        out = []
        with mock.patch("builtins.input", side_effect=lambda prompt="": next(inputs)), \
             mock.patch("builtins.print", side_effect=lambda *a, **k: out.append(" ".join(str(x) for x in a))):
            code = sm.run(self.path)
        return code, "\n".join(out)

    def test_cli_add_then_average_then_exit(self):
        code, out = self.run_cli(["1", "1", "Asha", "0"])
        self.assertEqual(code, 0)
        self.assertIn("Student added", out)

    def test_cli_reports_invalid_input_without_crashing(self):
        code, out = self.run_cli(["1", "0", "Asha", "0"])
        self.assertEqual(code, 0)
        self.assertIn("Not saved: Roll number must be greater than zero.", out)

    def test_cli_refuses_to_run_on_corrupt_file(self):
        with open(self.path, "w", encoding="utf-8") as f:
            f.write("not json")
        code, out = self.run_cli([])
        self.assertEqual(code, 1)
        self.assertIn("Nothing was changed", out)
        with open(self.path, encoding="utf-8") as f:
            self.assertEqual(f.read(), "not json")


if __name__ == "__main__":
    unittest.main(verbosity=2)
