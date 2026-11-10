"""Dev helper: collapse accidental three-decimal numbers (0.500 -> 0.5) in UI files."""
import re, sys, pathlib
pat = re.compile(r'(?<=\d)\.(\d)00(?!\d)')
changed = 0
for root in sys.argv[1:]:
    for p in pathlib.Path(root).rglob('*'):
        if p.suffix not in ('.tsx', '.css') or 'node_modules' in p.parts:
            continue
        s = p.read_text(encoding='utf-8')
        t = pat.sub(r'.\1', s)
        if t != s:
            p.write_text(t, encoding='utf-8')
            changed += 1
print('fixed files:', changed)
