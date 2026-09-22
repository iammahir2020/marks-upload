// A portability guard, not a style check.
//
// Windows and macOS default to case-INSENSITIVE filesystems. Vite (and
// tsc, and Node) resolve an extensionless import like `./results` by
// trying extensions in order — `.mjs .js .mts .ts .jsx .tsx` — and on a
// case-insensitive filesystem `results.ts` is found by a `stat` for
// `Results.ts`. So `import Results from './Results'` silently resolved to
// the pure-logic module `results.ts`, whose default export does not
// exist: every component rendered as `undefined`, with React's generic
// "Element type is invalid" as the only clue.
//
// That is exactly what happened here — `Landing.tsx`/`landing.ts` and
// `Results.tsx`/`results.ts` both existed, and the whole Landing and
// Results suites failed on Windows while passing on Linux. The files are
// now `landingShell.ts` and `resultsTable.ts`.
//
// This test fails on Linux too, where the collision is otherwise
// invisible — which is the point. The bug is created by whoever adds the
// second file, and that is usually not the person on the case-insensitive
// machine.
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const srcDir = path.dirname(fileURLToPath(import.meta.url));

describe('module filenames stay unambiguous on a case-insensitive filesystem', () => {
  it('has no two source files whose names differ only by case', () => {
    const collisions = new Map<string, string[]>();
    for (const name of readdirSync(srcDir)) {
      if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(name)) continue;
      // The stem is what an extensionless import actually matches on.
      const stem = name.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, '').toLowerCase();
      const seen = collisions.get(stem) ?? [];
      seen.push(name);
      collisions.set(stem, seen);
    }
    const clashing = [...collisions.values()].filter((names) => names.length > 1);
    expect(clashing).toEqual([]);
  });
});
