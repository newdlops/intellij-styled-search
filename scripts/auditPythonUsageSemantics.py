#!/usr/bin/env python3
"""Independent AST/symbol-table audit of statically provable Python usages.

Only module functions and explicit imports are resolved. Dynamic dispatch,
re-exports, object attributes and other uncertain locations remain unclassified.
Unclassified occurrences are never called false positives or true negatives.
"""
import argparse
import ast
from collections import Counter, defaultdict
import json
from pathlib import Path
import subprocess
import symtable


def location(path, lines, node, name=None):
    line = node.lineno - 1
    offset = node.col_offset
    if name is not None:
        line = node.end_lineno - 1
        offset = node.end_col_offset - len(name.encode('utf-8'))
    prefix = lines[line].encode('utf-8')[:offset].decode('utf-8')
    return (path, line, len(prefix.encode('utf-16-le')) // 2)


class Oracle:
    def __init__(self, workspace):
        self.workspace = workspace
        self.modules = {}
        self.module_paths = defaultdict(set)
        self.targets = {}
        self.required = defaultdict(set)
        self.truth = {}
        self.local_names = {}
        self.parse_errors = []
        for file in sorted(workspace.rglob('*.py')):
            if '.zoek-rs' in file.relative_to(workspace).parts:
                continue
            path = file.relative_to(workspace).as_posix()
            text = file.read_text(encoding='utf-8', errors='replace')
            try:
                tree = ast.parse(text, filename=path)
                table = symtable.symtable(text, path, 'exec')
            except (SyntaxError, ValueError) as error:
                self.parse_errors.append({'path': path, 'error': str(error)})
                continue
            module = path[:-3].replace('/', '.')
            if module.endswith('.__init__'):
                module = module[:-9]
            pieces = module.split('.')
            for start in range(len(pieces)):
                self.module_paths['.'.join(pieces[start:])].add(path)
            counts = Counter()
            bindings = {}
            def collect(nodes):
                for node in nodes:
                    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                        counts[node.name] += 1
                        bindings[node.name] = node
                    elif isinstance(node, (ast.Import, ast.ImportFrom)):
                        for alias in node.names:
                            counts[alias.asname or alias.name.split('.')[0]] += 1
                    elif isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store):
                        counts[node.id] += 1
                    elif not isinstance(node, (ast.Lambda, ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)):
                        collect(list(ast.iter_child_nodes(node)))
            collect(tree.body)
            functions = {name: node for name, node in bindings.items()
                         if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and counts[name] == 1}
            self.modules[path] = {'tree': tree, 'table': table, 'module': module,
                                  'lines': text.splitlines(), 'functions': functions}
            for name, node in functions.items():
                self.targets[(path, name)] = node
        for path, module in self.modules.items():
            Visitor(self, path, module).visit(module['tree'])

    def imported(self, path, module, name):
        candidates = self.module_paths.get(module, set())
        exact = {candidate for candidate in candidates
                 if candidate[:-3].replace('/', '.').removesuffix('.__init__') == module}
        candidates = exact or candidates
        if len(candidates) != 1:
            return None
        target = (next(iter(candidates)), name)
        return target if target in self.targets else None


class Visitor(ast.NodeVisitor):
    def __init__(self, oracle, path, module):
        self.oracle, self.path, self.module = oracle, path, module
        self.frames = [{'table': module['table'], 'imports': {}, 'moduleAliases': {}}]
        self.used = set()
        # Explicit module imports may be used by functions appearing before
        # the import in source order. Collect only module-level statements.
        for node in module['tree'].body:
            if isinstance(node, (ast.Import, ast.ImportFrom)):
                self.visit(node)

    def resolve(self, name):
        free = False
        for frame in reversed(self.frames):
            if free and frame['table'].get_type() == 'class':
                continue
            try:
                symbol = frame['table'].lookup(name)
            except KeyError:
                continue
            if symbol.is_global() or frame is self.frames[0]:
                global_frame = self.frames[0]
                target = (self.path, name)
                return target if target in self.oracle.targets else global_frame['imports'].get(name)
            if symbol.is_free() or symbol.is_nonlocal():
                free = True
                continue
            if symbol.is_local():
                return frame['imports'].get(name)
        return None

    def visit_ImportFrom(self, node):
        module = node.module or ''
        if node.level:
            package = self.module['module'].split('.')
            if not self.path.endswith('/__init__.py'):
                package.pop()
            module = '.'.join(package[:len(package) - node.level + 1] + ([module] if module else []))
        for alias in node.names:
            if alias.name != '*':
                self.frames[-1]['imports'][alias.asname or alias.name] = self.oracle.imported(self.path, module, alias.name)

    def visit_Import(self, node):
        for alias in node.names:
            self.frames[-1]['moduleAliases'][alias.asname or alias.name.split('.')[0]] = alias.name if alias.asname else alias.name.split('.')[0]

    def visit_Name(self, node):
        if not isinstance(node.ctx, ast.Load):
            return
        point = location(self.path, self.module['lines'], node)
        target = self.resolve(node.id)
        if target:
            self.oracle.required[target].add(point)
            self.oracle.truth[point] = target
        else:
            # A parameter/local binding proves that this token does not use
            # an unrelated module function with the same spelling.
            for frame in reversed(self.frames[1:]):
                try:
                    symbol = frame['table'].lookup(node.id)
                except KeyError:
                    continue
                if symbol.is_global():
                    break
                if symbol.is_local() and not symbol.is_imported():
                    self.oracle.local_names[point] = node.id
                    break

    def visit_Attribute(self, node):
        self.visit(node.value)
        if isinstance(node.value, ast.Name):
            name = node.value.id
            frame = self.frames[0]
            if len(self.frames) > 1:
                try:
                    symbol = self.frames[-1]['table'].lookup(name)
                    if symbol.is_local() and name not in self.frames[-1]['moduleAliases']:
                        return
                    if symbol.is_local():
                        frame = self.frames[-1]
                except KeyError:
                    pass
            module = frame['moduleAliases'].get(name)
            if module:
                target = self.oracle.imported(self.path, module, node.attr)
                if target:
                    point = location(self.path, self.module['lines'], node, node.attr)
                    self.oracle.required[target].add(point)
                    self.oracle.truth[point] = target

    def enter(self, node, name, body):
        children = self.frames[-1]['table'].get_children()
        table = next((child for child in children if child not in self.used
                      and child.get_name() == name and child.get_lineno() == node.lineno), None)
        if table is None:
            return
        self.used.add(table)
        self.frames.append({'table': table, 'imports': {}, 'moduleAliases': {}})
        for child in body:
            self.visit(child)
        self.frames.pop()

    def visit_FunctionDef(self, node):
        for child in [*node.decorator_list, *node.args.defaults, *[x for x in node.args.kw_defaults if x], node.returns]:
            if child:
                self.visit(child)
        for arg in [*node.args.posonlyargs, *node.args.args, *node.args.kwonlyargs, node.args.vararg, node.args.kwarg]:
            if arg and arg.annotation:
                self.visit(arg.annotation)
        self.enter(node, node.name, node.body)

    visit_AsyncFunctionDef = visit_FunctionDef

    def visit_ClassDef(self, node):
        for child in [*node.decorator_list, *node.bases, *node.keywords]:
            self.visit(child)
        self.enter(node, node.name, node.body)

    def visit_Lambda(self, node):
        for child in [*node.args.defaults, *[x for x in node.args.kw_defaults if x]]:
            self.visit(child)
        self.enter(node, 'lambda', [node.body])

    def visit_ListComp(self, node):
        self.visit(node.generators[0].iter)
        remaining = [node.generators[0].target, *node.generators[0].ifs]
        for generator in node.generators[1:]:
            remaining += [generator.iter, generator.target, *generator.ifs]
        remaining += [node.elt] if hasattr(node, 'elt') else [node.key, node.value]
        names = {ast.ListComp: 'listcomp', ast.SetComp: 'setcomp', ast.DictComp: 'dictcomp', ast.GeneratorExp: 'genexpr'}
        self.enter(node, names[type(node)], remaining)

    visit_SetComp = visit_ListComp
    visit_DictComp = visit_ListComp
    visit_GeneratorExp = visit_ListComp


def query(binary, *args):
    result = subprocess.run([str(binary), *map(str, args)], capture_output=True,
                            text=True, encoding='utf-8', check=True, timeout=120)
    response = json.loads(result.stdout)
    if not response.get('ok'):
        raise ValueError(response)
    return response


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('workspace', type=Path)
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--samples', type=int, default=20)
    args = parser.parse_args()
    oracle = Oracle(args.workspace.resolve())
    targets = sorted(oracle.required, key=lambda key: (-len(oracle.required[key]), key))[:args.samples]
    results = []
    for path, name in targets:
        response = query(args.binary.resolve(), 'graph-symbol-query', args.workspace,
                         '--query', name, '--limit', 10000)
        symbols = [symbol for symbol in response['symbols'] if symbol['relPath'] == path
                   and symbol['name'] == name and symbol['range']['startLine'] == oracle.targets[(path, name)].lineno - 1]
        if len(symbols) != 1:
            results.append({'path': path, 'name': name, 'declarationsFound': len(symbols), 'error': 'declaration not uniquely indexed'})
            continue
        page = query(args.binary.resolve(), 'graph-query', args.workspace,
                     '--symbol-id', symbols[0]['id'], '--limit', 20000)
        refs = page['references']
        actual = {(r['relPath'], r['range']['startLine'], r['range']['startColumn']) for r in refs}
        wanted = oracle.required[(path, name)]
        invalid = {point for point in actual if (point in oracle.truth and oracle.truth[point] != (path, name))
                   or oracle.local_names.get(point) == name}
        classified = invalid | (actual & wanted)
        entry = {'path': path, 'name': name, 'symbolId': symbols[0]['id'],
                 'required': len(wanted), 'requiredFound': len(actual & wanted),
                 'provenOtherBinding': len(invalid), 'unclassified': len(actual - classified),
                 'otherBindingConfidences': dict(Counter(r.get('confidence', 'unknown') for r in refs
                    if (r['relPath'], r['range']['startLine'], r['range']['startColumn']) in invalid)),
                 'totalReferences': page['totalReferences'], 'fullyEnumerated': len(refs) == page['totalReferences'],
                 'missing': sorted(wanted - actual) if len(refs) == page['totalReferences'] else None,
                 'otherBindingLocations': sorted(invalid)}
        results.append(entry)
    report = {'oracle': 'Python AST and symtable; module functions, explicit imports, lexical bindings',
              'limitations': 'Dynamic dispatch and re-exports remain unclassified; no whole-project precision/recall claim.',
              'pythonFilesParsed': len(oracle.modules), 'parseErrors': oracle.parse_errors,
              'targets': results}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({key: value for key, value in report.items() if key != 'targets'}, ensure_ascii=False))
    print(json.dumps({'targets': len(results), 'required': sum(x.get('required', 0) for x in results),
                      'found': sum(x.get('requiredFound', 0) for x in results),
                      'provenOtherBinding': sum(x.get('provenOtherBinding', 0) for x in results),
                      'unclassified': sum(x.get('unclassified', 0) for x in results)}))


if __name__ == '__main__':
    main()
