"""Student Management System.

Stores students (roll number, name, subject marks) in a JSON file.
Every change is validated, written atomically, and only applied in memory after the
file is saved, so a failed save never leaves memory and disk out of step.
"""

import copy
import json
import math
import os
import re
import sys
import tempfile
from datetime import datetime

MAX_MARK = 100.0
MIN_MARK = 0.0
MAX_NAME_LENGTH = 60
NAME_PATTERN = re.compile(r"^[^\W\d_](?:[^\W\d_]|[ .'\-])*$")  # starts with a letter; then letters, spaces, . ' -
SCHEMA_VERSION = 1


class ValidationError(ValueError):
    """The user typed something that is not allowed. The data is unchanged."""


class DataFileError(Exception):
    """The data file exists but cannot be read or has the wrong structure. Nothing is written."""


class SaveError(Exception):
    """The data could not be written to disk. Memory is unchanged."""


# ---------- validation helpers ----------

def validate_roll(value):
    """A roll number is a whole number greater than zero. Accepts ints or text like '12'."""
    if isinstance(value, bool):
        raise ValidationError("Roll number must be a number, not True/False.")
    if isinstance(value, float):
        if not math.isfinite(value) or not value.is_integer():
            raise ValidationError("Roll number must be a whole number.")
        value = int(value)
    if isinstance(value, str):
        text = value.strip()
        if not text.isdigit():
            raise ValidationError("Roll number must be a whole number, like 12.")
        value = int(text)
    if not isinstance(value, int):
        raise ValidationError("Roll number must be a whole number.")
    if value <= 0:
        raise ValidationError("Roll number must be greater than zero.")
    return value


def validate_name(value):
    """Names: 1 to 60 characters, letters first, then letters, spaces, dots, apostrophes or hyphens."""
    if not isinstance(value, str):
        raise ValidationError("Name must be text.")
    text = " ".join(value.split())  # collapse extra spaces, trim ends
    if not text:
        raise ValidationError("Name cannot be empty.")
    if len(text) > MAX_NAME_LENGTH:
        raise ValidationError("Name is too long (max %d characters)." % MAX_NAME_LENGTH)
    if not NAME_PATTERN.match(text):
        raise ValidationError("Name may contain only letters, spaces, dots, apostrophes and hyphens.")
    return text


def validate_mark(value):
    """A mark is a finite number from 0 to 100. Text like '85' or '72.5' is accepted."""
    if isinstance(value, bool):
        raise ValidationError("Mark must be a number, not True/False.")
    if isinstance(value, str):
        text = value.strip()
        try:
            value = float(text)
        except ValueError:
            raise ValidationError("Mark must be a number, like 85.")
    if not isinstance(value, (int, float)):
        raise ValidationError("Mark must be a number.")
    if not math.isfinite(value):
        raise ValidationError("Mark must be a finite number (not infinity or NaN).")
    if value < MIN_MARK or value > MAX_MARK:
        raise ValidationError("Mark must be between %d and %d." % (MIN_MARK, MAX_MARK))
    return float(value)


def validate_subject(value):
    if not isinstance(value, str):
        raise ValidationError("Subject must be text.")
    text = " ".join(value.split())
    if not text:
        raise ValidationError("Subject cannot be empty.")
    if len(text) > 40:
        raise ValidationError("Subject name is too long (max 40 characters).")
    return text


def grade_for(average):
    """Letter grade from an average mark."""
    if average is None:
        return "No marks yet"
    if average >= 80:
        return "A"
    if average >= 70:
        return "B"
    if average >= 60:
        return "C"
    if average >= 50:
        return "D"
    return "F"


# ---------- file structure ----------

def validate_data(data):
    """Checks the structure of loaded JSON. Raises DataFileError with the first problem found."""
    if not isinstance(data, dict):
        raise DataFileError("top level must be a JSON object")
    if data.get("version") != SCHEMA_VERSION:
        raise DataFileError("unknown or missing file version")
    students = data.get("students")
    if not isinstance(students, list):
        raise DataFileError('"students" must be a list')
    seen_rolls = set()
    clean = []
    for i, s in enumerate(students):
        where = "student #%d" % (i + 1)
        if not isinstance(s, dict):
            raise DataFileError(where + " must be an object")
        try:
            roll = validate_roll(s.get("roll"))
            name = validate_name(s.get("name"))
        except ValidationError as e:
            raise DataFileError(where + ": " + str(e))
        if roll in seen_rolls:
            raise DataFileError("roll number %d appears more than once" % roll)
        seen_rolls.add(roll)
        marks = s.get("marks")
        if not isinstance(marks, dict):
            raise DataFileError(where + ' ("marks" must be an object)')
        clean_marks = {}
        for subject, mark in marks.items():
            try:
                clean_marks[validate_subject(subject)] = validate_mark(mark)
            except ValidationError as e:
                raise DataFileError("%s, subject %r: %s" % (where, subject, e))
        clean.append({"roll": roll, "name": name, "marks": clean_marks})
    return clean


# ---------- the store ----------

class StudentStore:
    def __init__(self, path):
        self.path = path
        self.students = []  # list of dicts: roll, name, marks

    # --- loading and saving ---

    def load(self):
        """Loads the file. A missing file means no students yet. A broken file raises DataFileError
        and is left exactly as it is, so nothing is lost."""
        if not os.path.exists(self.path):
            self.students = []
            return
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                raw = f.read()
        except OSError as e:
            raise DataFileError("could not read %s: %s" % (self.path, e))
        try:
            data = json.loads(raw)
        except json.JSONDecodeError as e:
            raise DataFileError("the file is not valid JSON (line %d, column %d). It was not changed." % (e.lineno, e.colno))
        self.students = validate_data(data)

    def _write_atomic(self, data):
        """Writes to a temporary file, then replaces the real file in one step."""
        directory = os.path.dirname(os.path.abspath(self.path)) or "."
        tmp_path = None
        try:
            fd, tmp_path = tempfile.mkstemp(prefix=".students-", suffix=".tmp", dir=directory)
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2, ensure_ascii=False)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp_path, self.path)
            tmp_path = None
        except OSError as e:
            raise SaveError("could not save to %s: %s. Your last saved data is unchanged." % (self.path, e))
        finally:
            if tmp_path and os.path.exists(tmp_path):
                try:
                    os.remove(tmp_path)
                except OSError:
                    pass

    def _commit(self, new_students):
        """Saves new_students to disk; only on success does memory change."""
        data = {"version": SCHEMA_VERSION, "saved_at": datetime.now().isoformat(timespec="seconds"), "students": new_students}
        self._write_atomic(data)
        self.students = new_students

    def _find_index(self, roll):
        for i, s in enumerate(self.students):
            if s["roll"] == roll:
                return i
        return -1

    def get(self, roll):
        i = self._find_index(validate_roll(roll))
        if i < 0:
            raise ValidationError("No student has roll number %d." % roll)
        return copy.deepcopy(self.students[i])

    # --- operations ---

    def add_student(self, roll, name, marks=None):
        roll = validate_roll(roll)
        name = validate_name(name)
        if self._find_index(roll) >= 0:
            raise ValidationError("Roll number %d is already used." % roll)
        clean_marks = {}
        for subject, mark in (marks or {}).items():
            clean_marks[validate_subject(subject)] = validate_mark(mark)
        new = copy.deepcopy(self.students)
        new.append({"roll": roll, "name": name, "marks": clean_marks})
        self._commit(new)

    def search(self, text):
        """Finds students whose roll number equals the text, or whose name contains it (case-insensitive)."""
        query = str(text or "").strip()
        if not query:
            raise ValidationError("Type a roll number or part of a name to search.")
        if query.isdigit():
            hits = [s for s in self.students if s["roll"] == int(query)]
            if hits:
                return copy.deepcopy(hits)
        q = query.lower()
        return copy.deepcopy([s for s in self.students if q in s["name"].lower()])

    def update_name(self, roll, name):
        roll = validate_roll(roll)
        name = validate_name(name)
        i = self._find_index(roll)
        if i < 0:
            raise ValidationError("No student has roll number %d." % roll)
        new = copy.deepcopy(self.students)
        new[i]["name"] = name
        self._commit(new)

    def update_roll(self, old_roll, new_roll):
        old_roll = validate_roll(old_roll)
        new_roll = validate_roll(new_roll)
        i = self._find_index(old_roll)
        if i < 0:
            raise ValidationError("No student has roll number %d." % old_roll)
        if new_roll != old_roll and self._find_index(new_roll) >= 0:
            raise ValidationError("Roll number %d is already used." % new_roll)
        new = copy.deepcopy(self.students)
        new[i]["roll"] = new_roll
        self._commit(new)

    def set_mark(self, roll, subject, mark):
        roll = validate_roll(roll)
        subject = validate_subject(subject)
        mark = validate_mark(mark)
        i = self._find_index(roll)
        if i < 0:
            raise ValidationError("No student has roll number %d." % roll)
        new = copy.deepcopy(self.students)
        new[i]["marks"][subject] = mark
        self._commit(new)

    def delete(self, roll):
        roll = validate_roll(roll)
        i = self._find_index(roll)
        if i < 0:
            raise ValidationError("No student has roll number %d." % roll)
        new = copy.deepcopy(self.students)
        del new[i]
        self._commit(new)

    def average(self, roll):
        """Average of a student's marks, or None when there are no marks."""
        s = self.get(roll)
        if not s["marks"]:
            return None
        return sum(s["marks"].values()) / len(s["marks"])

    def grade(self, roll):
        return grade_for(self.average(roll))


# ---------- beginner-friendly command line ----------

MENU = """
==== Student Management ====
1. Add student
2. Search student
3. Update student name
4. Update roll number
5. Add or change a mark
6. Show average and grade
7. Delete student
8. List all students
0. Exit
"""


def ask(prompt):
    try:
        return input(prompt)
    except EOFError:
        raise SystemExit("\nInput closed. Exiting.")


def show(s):
    print("Roll %d - %s" % (s["roll"], s["name"]))
    for subject, mark in sorted(s["marks"].items()):
        print("   %-20s %6.2f" % (subject, mark))


def run(path):
    store = StudentStore(path)
    try:
        store.load()
    except DataFileError as e:
        print("Could not open your data file: %s" % e)
        print("Fix or move the file, then start again. Nothing was changed.")
        return 1
    while True:
        print(MENU)
        choice = ask("Choose an option: ").strip()
        try:
            if choice == "1":
                store.add_student(ask("Roll number: "), ask("Name: "))
                print("Student added.")
            elif choice == "2":
                hits = store.search(ask("Roll number or part of name: "))
                if not hits:
                    print("No matching student.")
                for s in hits:
                    show(s)
            elif choice == "3":
                store.update_name(ask("Roll number: "), ask("New name: "))
                print("Name updated.")
            elif choice == "4":
                store.update_roll(ask("Current roll number: "), ask("New roll number: "))
                print("Roll number updated.")
            elif choice == "5":
                store.set_mark(ask("Roll number: "), ask("Subject: "), ask("Mark (0-100): "))
                print("Mark saved.")
            elif choice == "6":
                roll = ask("Roll number: ")
                s = store.get(roll)
                avg = store.average(roll)
                show(s)
                if avg is None:
                    print("No marks yet, so no average or grade.")
                else:
                    print("Average: %.2f   Grade: %s" % (avg, grade_for(avg)))
            elif choice == "7":
                roll = ask("Roll number to delete: ")
                if ask("Type YES to delete roll %s: " % roll).strip() == "YES":
                    store.delete(roll)
                    print("Student deleted.")
                else:
                    print("Delete cancelled.")
            elif choice == "8":
                if not store.students:
                    print("No students yet.")
                for s in sorted(store.students, key=lambda x: x["roll"]):
                    show(s)
            elif choice == "0":
                print("Goodbye.")
                return 0
            else:
                print("Please choose a number from the menu.")
        except ValidationError as e:
            print("Not saved: " + str(e))
        except SaveError as e:
            print("Not saved: " + str(e))


if __name__ == "__main__":
    data_path = sys.argv[1] if len(sys.argv) > 1 else "students.json"
    sys.exit(run(data_path))
