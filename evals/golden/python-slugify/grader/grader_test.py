# Hidden grader: copied in after the agent finishes.
import unittest
from slug import slugify


class SlugTest(unittest.TestCase):
    def test_basic(self):
        self.assertEqual(slugify("Hello, World!"), "hello-world")
        self.assertEqual(slugify("  --Agentic AI 101--  "), "agentic-ai-101")

    def test_accents_and_non_ascii(self):
        self.assertEqual(slugify("Café Déjà Vu"), "cafe-deja-vu")
        self.assertEqual(slugify("హైదరాబాద్ Hyderabad"), "hyderabad")
        self.assertEqual(slugify("€€€"), "")

    def test_max_len(self):
        self.assertEqual(slugify("abc def ghi", max_len=4), "abc")
        self.assertTrue(len(slugify("x" * 200)) == 60)


if __name__ == "__main__":
    unittest.main()
