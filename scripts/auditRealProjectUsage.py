#!/usr/bin/env python3
"""Measure live usage queries in isolated copies of real source trees.

Copies rg-visible supported sources, never an existing index. Reports CLI
delivery latency (including process startup) and per-process peak RSS; it does
not equate count/list parity with semantic precision or recall.
"""
import argparse
from collections import Counter
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time

EXTENSIONS = {'.py', '.pyi', '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx',
              '.mjs', '.cjs', '.java', '.kt', '.kts', '.go', '.rs'}
EXCLUDES = {'.git', '.zoek-rs', '.zoekt-rs', '.codeidx', '.vscode', '.vscode-test',
            '.lh', 'node_modules', 'target', 'out', 'dist', 'build', 'coverage',
            '.next', '.nuxt', '.svelte-kit', '.angular', '.venv', 'venv',
            '__pycache__', '.mypy_cache', '.pytest_cache', '.ruff_cache', '.gradle', '.tox'}


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')


def snapshot(source, destination):
    args = ['rg', '--files', '--hidden', '.']
    for name in sorted(EXCLUDES):
        args += ['--glob', f'!**/{name}/**']
    result = subprocess.run(args, cwd=source, capture_output=True, text=True, check=True)
    files = sorted(Path(line) for line in result.stdout.splitlines()
                   if Path(line).suffix.lower() in EXTENSIONS)
    digest = hashlib.sha256()
    total = 0
    extensions = Counter()
    for relative in files:
        original = source / relative
        if original.is_symlink():
            continue
        data = original.read_bytes()
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        digest.update(str(relative).encode() + b'\0' + data + b'\0')
        total += len(data)
        extensions[relative.suffix.lower()] += 1
    head = subprocess.run(['git', '-C', str(source), 'rev-parse', 'HEAD'],
                          capture_output=True, text=True)
    return {'source': str(source), 'workspace': str(destination),
            'sourceFiles': sum(extensions.values()), 'sourceBytes': total,
            'sourceSha256': digest.hexdigest(), 'extensions': dict(extensions),
            'gitHead': head.stdout.strip() if head.returncode == 0 else None,
            'selection': 'rg-visible supported source files; common build/dependency/cache directories excluded'}


def invoke(binary, output, label, *arguments, timeout=900):
    stdout = output / f'{label}.json'
    stderr = output / f'{label}.log'
    metrics = output / f'{label}.resources'
    args = [str(binary), *map(str, arguments)]
    if sys.platform == 'darwin':
        args = ['/usr/bin/time', '-l', '-o', str(metrics), *args]
    elif sys.platform.startswith('linux'):
        args = ['/usr/bin/time', '-v', '-o', str(metrics), *args]
    else:
        raise ValueError('Per-process RSS measurements currently require macOS or Linux.')
    started = time.perf_counter()
    with stdout.open('w') as out, stderr.open('w') as err:
        result = subprocess.run(args, stdout=out, stderr=err, timeout=timeout)
    elapsed = (time.perf_counter() - started) * 1000
    if result.returncode:
        raise ValueError(f'{label}: exit {result.returncode}; see {stderr}')
    response = json.loads(stdout.read_text())
    if not response.get('ok', response.get('type') == 'graph-audit-counts'):
        raise ValueError(f'{label}: {response}')
    text = metrics.read_text()
    match = re.search(r'(\d+)\s+maximum resident set size', text)
    if match:
        rss = int(match[1])
    else:
        match = re.search(r'Maximum resident set size \(kbytes\):\s*(\d+)', text)
        if not match:
            raise ValueError(f'RSS missing from {metrics}')
        rss = int(match[1]) * 1024
    return response, {'elapsedMs': elapsed, 'peakRssBytes': rss}


def percentile(values, fraction):
    import math
    return sorted(values)[max(0, math.ceil(len(values) * fraction) - 1)]


def audit(binary, source, output, workers, samples, resume=False):
    if resume and (output / 'snapshot.json').exists():
        report = json.loads((output / 'snapshot.json').read_text(encoding='utf-8'))
        if report['source'] != str(source) or not Path(report['workspace']).is_dir():
            raise ValueError('The recorded source snapshot is unavailable or belongs to another project.')
        workspace = Path(report['workspace'])
    else:
        workspace = Path(tempfile.mkdtemp(prefix='ijss-real-usage-', dir='/private/tmp' if sys.platform == 'darwin' else None))
        report = snapshot(source, workspace)
    write_json(output / 'snapshot.json', report)
    print(f'{source.name}: copied {report["sourceFiles"]} sources to {workspace}', flush=True)
    built, resources = invoke(binary, output, 'build', 'graph-rebuild', workspace,
                             '--workers', workers, '--max-file-size', 0)
    report['build'] = {'resources': resources, 'response': built}
    write_json(output / 'report.json', report)
    print(f'{source.name}: build {resources["elapsedMs"]:.0f}ms; {resources["peakRssBytes"]/1048576:.0f}MiB peak', flush=True)
    parity, resources = invoke(binary, output, 'count-parity', 'graph-audit-counts', workspace,
                               '--dump-first-party', output / 'counts.tsv')
    report['countParity'] = {'resources': resources, 'response': parity}
    write_json(output / 'report.json', report)
    if parity['undercount']['symbols'] or parity['overcount']['symbols']:
        raise ValueError(f'{source.name}: live count/list mismatch; see {output}')
    symbols, lookup = invoke(binary, output, 'first-symbol-query', 'graph-symbol-query', workspace,
                             '--query', '', '--limit', 40)
    report['firstSymbolQuery'] = lookup
    query_samples = []
    for index, symbol in enumerate(symbols['symbols'][:samples]):
        page, measurement = invoke(binary, output, f'usage-first-{index}', 'graph-query', workspace,
                                  '--symbol-id', symbol['id'], '--limit', 40)
        if page['totalReferences'] != symbol['usageCount']:
            raise ValueError(f'Count/page mismatch for {symbol["id"]}')
        query_samples.append({'symbol': symbol, 'resources': measurement,
                              'returned': len(page['references']), 'total': page['totalReferences'],
                              'nextOffset': page.get('nextOffset'), 'generation': page.get('generation')})
    report['firstUsagePages'] = query_samples
    elapsed = [entry['resources']['elapsedMs'] for entry in query_samples]
    report['firstUsageSummary'] = {'samples': len(elapsed), 'p50Ms': percentile(elapsed, .5),
                                  'p95Ms': percentile(elapsed, .95),
                                  'maxPeakRssBytes': max(entry['resources']['peakRssBytes'] for entry in query_samples),
                                  'measurement': 'CLI delivery including startup and JSON; immediately after build/audit; OS caches not flushed'}
    report['binarySha256'] = hashlib.sha256(binary.read_bytes()).hexdigest()
    write_json(output / 'report.json', report)
    print(f'{source.name}: {parity["symbolsChecked"]} symbols, count parity OK; usage p95 {report["firstUsageSummary"]["p95Ms"]:.1f}ms', flush=True)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('projects', nargs='+', type=Path)
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--workers', type=int, default=8)
    parser.add_argument('--samples', type=int, default=20)
    parser.add_argument('--resume', action='store_true', help='reuse recorded isolated source snapshots')
    args = parser.parse_args()
    reports = []
    for index, source in enumerate(args.projects):
        destination = args.output.resolve() / f'{index}-{source.name}'
        destination.mkdir(parents=True, exist_ok=True)
        reports.append(audit(args.binary.resolve(), source.resolve(), destination, args.workers, args.samples, args.resume))
    write_json(args.output.resolve() / 'summary.json', reports)


if __name__ == '__main__':
    main()
