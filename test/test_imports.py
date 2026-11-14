"""The dark_factory_cli package: every module imports on its own, and the import graph has no cycles."""

import ast
import os
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.path.join(HERE, '..', 'plugins', 'dark-factory', 'lib')
PACKAGE = os.path.join(LIB, 'dark_factory_cli')
MODULES = sorted(f[:-3] for f in os.listdir(PACKAGE) if f.endswith('.py') and f != '__init__.py')


def sibling_imports(name):
    """The package siblings a module imports, wherever in the file the import is written."""
    with open(os.path.join(PACKAGE, name + '.py'), encoding='utf-8') as f:
        tree = ast.parse(f.read())
    deps = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.level == 1:
            deps.update([node.module] if node.module else [a.name for a in node.names])
        elif isinstance(node, ast.ImportFrom) and node.module and node.module.startswith('dark_factory_cli'):
            rest = node.module.split('.')[1:]
            deps.update(rest[:1] if rest else [a.name for a in node.names])
    return {d.split('.')[0] for d in deps} - {name}


class PackageImports(unittest.TestCase):
    def test_each_module_imports_standalone(self):
        for name in MODULES:
            with self.subTest(module=name):
                # A bare package object stands in for __init__, which imports every module: only the
                # module's own imports run, in a fresh interpreter.
                code = ('import sys, types; pkg = types.ModuleType("dark_factory_cli"); pkg.__path__ = [sys.argv[1]]; '
                        'sys.modules["dark_factory_cli"] = pkg; import importlib; '
                        f'importlib.import_module("dark_factory_cli.{name}")')
                r = subprocess.run([sys.executable, '-B', '-c', code, PACKAGE], cwd=LIB,
                                   stdin=subprocess.DEVNULL, capture_output=True, text=True)
                self.assertEqual(r.returncode, 0, r.stderr)

    def test_imports_are_at_the_top(self):
        for name in MODULES:
            with open(os.path.join(PACKAGE, name + '.py'), encoding='utf-8') as f:
                tree = ast.parse(f.read())
            nested = [n.lineno for n in ast.walk(tree) if isinstance(n, (ast.Import, ast.ImportFrom))
                      and n not in tree.body]
            past = [n.lineno for i, n in enumerate(tree.body) if isinstance(n, (ast.Import, ast.ImportFrom))
                    and any(not isinstance(m, (ast.Import, ast.ImportFrom, ast.Expr)) for m in tree.body[:i])]
            with self.subTest(module=name):
                self.assertEqual(nested + past, [], 'imports below the top of the module')

    def test_import_graph_is_acyclic(self):
        graph = {name: sibling_imports(name) for name in MODULES}
        for name, deps in graph.items():
            self.assertTrue(deps <= set(MODULES), f'{name} imports unknown modules {deps - set(MODULES)}')
        state = {}

        def visit(node, path):
            if state.get(node) == 'done':
                return
            if state.get(node) == 'open':
                self.fail('import cycle: ' + ' -> '.join(path[path.index(node):] + [node]))
            state[node] = 'open'
            for dep in sorted(graph[node]):
                visit(dep, path + [node])
            state[node] = 'done'

        for name in MODULES:
            visit(name, [])


if __name__ == '__main__':
    unittest.main()
