import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { stagesFromReport, STAGE_ORDER } from './swing-report-stages.ts';
import { buildReport, type PosePhase } from './swing-analysis.ts';

const poses = (): PosePhase[] => [
  { label: 'Setup', joints: { head: [0.5, 0.9] }, t: 0.10 },
  { label: 'Load', joints: { head: [0.48, 0.9] }, t: 0.40 },
  { label: 'Contact', joints: { head: [0.5, 0.88] }, t: 0.62 },
  { label: 'Finish', joints: { head: [0.52, 0.88] }, t: 0.85 },
];

const fullReport = () =>
  buildReport({
    name: 'Sample Hitter', sport: 'baseball', ageMode: 'full',
    scores: { head: 92, posture: 60, balance: 80, stride: 40 },
    stats: { head: '5% travel', posture: 'holds', balance: 'centered', stride: 'quiet' },
    poses: poses(),
  });

test('stagesFromReport returns the four stages in swing order', () => {
  const cards = stagesFromReport(fullReport());
  assert.deepEqual(cards.map((c) => c.stage), STAGE_ORDER);
  assert.deepEqual(cards.map((c) => c.label), ['Setup', 'Load', 'Contact', 'Finish']);
});

test('each stage carries the reads measured there (mapped, not fabricated)', () => {
  const cards = stagesFromReport(fullReport());
  const byStage = Object.fromEntries(cards.map((c) => [c.stage, c]));
  // Setup → posture + balance; Load → head (+ stride); Contact → head + posture; Finish → balance + posture
  assert.deepEqual(byStage.setup.ratings.map((r) => r.key).sort(), ['balance', 'posture']);
  assert.ok(byStage.load.ratings.some((r) => r.key === 'head'));
  assert.deepEqual(byStage.contact.ratings.map((r) => r.key).sort(), ['head', 'posture']);
  assert.deepEqual(byStage.finish.ratings.map((r) => r.key).sort(), ['balance', 'posture']);
});

test('the card never invents a per-stage score — ratings are real MetricReads from the report', () => {
  const report = fullReport();
  const cards = stagesFromReport(report);
  for (const c of cards) {
    for (const r of c.ratings) {
      assert.ok(report.metrics.includes(r), 'every rating is an actual graded metric, not a new number');
    }
  }
});

test('fixText comes from the lowest-graded read on the card (the thing to chase)', () => {
  // contact has head (92, great) + posture (60, good) → fix should target posture
  const byStage = Object.fromEntries(stagesFromReport(fullReport()).map((c) => [c.stage, c]));
  assert.ok(byStage.contact.fixText && /posture|chest|down/i.test(byStage.contact.fixText));
});

test('stage frame-time is exposed so the UI can fetch the real video frame', () => {
  const byStage = Object.fromEntries(stagesFromReport(fullReport()).map((c) => [c.stage, c]));
  assert.equal(byStage.contact.t, 0.62);
  assert.equal(byStage.setup.t, 0.10);
});

test('attaching keyframe images by stage fills imageUri', () => {
  const cards = stagesFromReport(fullReport(), { contact: 'data:image/jpeg;base64,AAA' });
  const contact = cards.find((c) => c.stage === 'contact')!;
  assert.equal(contact.imageUri, 'data:image/jpeg;base64,AAA');
  assert.equal(cards.find((c) => c.stage === 'setup')!.imageUri, undefined);
});

test('young mode (no stride/sequence) still produces coherent cards, gracefully', () => {
  const young = buildReport({
    name: 'Junior', sport: 'baseball', ageMode: 'young',
    scores: { head: 80, balance: 75, posture: 70 }, poses: poses(),
  });
  const cards = stagesFromReport(young);
  assert.equal(cards.length, 4);
  // load maps to head (+stride), but young has no stride → just head, never empty
  const load = cards.find((c) => c.stage === 'load')!;
  assert.ok(load.ratings.length >= 1 && load.ratings.every((r) => r.key !== 'stride'));
});

test('a narration pool key per card (for rotating narrated intros)', () => {
  const cards = stagesFromReport(fullReport());
  assert.deepEqual(cards.map((c) => c.narrationPool), ['cardSetup', 'cardLoad', 'cardContact', 'cardFinish']);
});
