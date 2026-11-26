import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeDocumentHeuristically } from '../src/lib/analysisParser';

interface BenchmarkRecord {
  id: string;
  category: string;
  expectedFlagged: boolean;
  expectedSeverity: 'critical' | 'high' | 'medium' | 'low';
  text: string;
}

function loadBenchmarkRecords(): BenchmarkRecord[] {
  const filePath = resolve(process.cwd(), 'data/cuad_legal_benchmark.jsonl');
  const raw = readFileSync(filePath, 'utf8');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as BenchmarkRecord);
}

describe('CUAD Adversarial Legal Benchmark', () => {
  const records = loadBenchmarkRecords();
  const traps = records.filter((r) => r.expectedFlagged);
  const controls = records.filter((r) => !r.expectedFlagged);

  it('contains at least 45 structured records (35+ traps, 10+ controls)', () => {
    expect(records.length).toBeGreaterThanOrEqual(45);
    expect(traps.length).toBeGreaterThanOrEqual(35);
    expect(controls.length).toBeGreaterThanOrEqual(10);
  });

  it('achieves >= 90% recall on adversarial legal traps', () => {
    let detected = 0;
    const missed: string[] = [];

    for (const trap of traps) {
      const result = analyzeDocumentHeuristically(trap.text);
      if (result.clauses.length > 0) {
        detected++;
      } else {
        missed.push(`${trap.id} (${trap.category})`);
      }
    }

    const recall = detected / traps.length;
    expect(
      recall,
      `Recall ${(recall * 100).toFixed(1)}% below 90%. Missed: ${missed.join(', ')}`
    ).toBeGreaterThanOrEqual(0.9);
  });

  it('achieves <= 10% false-positive rate on benign control clauses', () => {
    let falsePositives = 0;
    const flaggedControls: string[] = [];

    for (const ctrl of controls) {
      const result = analyzeDocumentHeuristically(ctrl.text);
      if (result.clauses.length > 0) {
        falsePositives++;
        flaggedControls.push(
          `${ctrl.id} (${ctrl.category}): ${result.clauses.map((c) => c.id).join(',')}`
        );
      }
    }

    const fpr = falsePositives / controls.length;
    expect(
      fpr,
      `False-positive rate ${(fpr * 100).toFixed(1)}% above 10%. Flagged: ${flaggedControls.join('; ')}`
    ).toBeLessThanOrEqual(0.1);
  });

  it('detects compound Unilateral Modification + Mandatory Arbitration exposure', () => {
    const combined =
      'Vendor reserves the right to modify these terms at any time in its sole discretion without notice, and continued use constitutes acceptance. All disputes shall be resolved by binding arbitration and Customer waives any class action.';
    const result = analyzeDocumentHeuristically(combined);
    expect(
      result.crossClauseFindings.some(
        (f) => f.id === 'cross-unilateral-arbitration'
      )
    ).toBe(true);
  });
});
