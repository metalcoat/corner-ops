import unittest
from verify_no_runtime_ddl import ddl_matches
class GuardTest(unittest.TestCase):
    def test_variants(self):
        for sql in ["CREATE OR REPLACE FUNCTION f()", "CREATE UNIQUE INDEX x", "CREATE\nOR REPLACE\nFUNCTION f()", "CREATE /* comment */ UNIQUE INDEX x", "ALTER TABLE t", "DROP FUNCTION f()", "TRUNCATE TABLE t"]:
            with self.subTest(sql=sql): self.assertTrue(ddl_matches(sql))
    def test_queries(self):
        self.assertFalse(ddl_matches("SELECT * FROM table_name; UPDATE employees SET active = TRUE;"))
if __name__ == '__main__': unittest.main()
