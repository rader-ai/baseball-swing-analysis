# baseball-swing-analysis

### Grade what the camera can actually see. Skip what it can't.

Film a swing from the side and you'll often get a hip-rotation number back. From one phone on a
tripod, that number is mostly guesswork dressed up as data: hips turn toward and away from the
lens, and a single camera can't see depth.

**baseball-swing-analysis** grades the parts of a swing a single camera reads well, tells you which parts
are estimates, and turns it into one plain-English report with one thing to work on.

It's the open-source swing engine inside the [Swing Dino](https://swingdino.com) app. Pure
TypeScript. Zero dependencies. No ML model, no cloud call.

```js
import { buildReport } from 'baseball-swing-analysis/swing-analysis';

const report = buildReport({
  name: 'Sam', sport: 'baseball', ageMode: 'full',
  scores: { head: 88, posture: 81, balance: 74, stride: 52 },
});
report.overallGrade; // 78
report.headline;     // "Your quiet head and posture look great. The one to chase next: lower half / stride."
report.metrics;      // per-metric grade, what good looks like, why it matters, a drill if it needs work
```

Want the numbers side (exit velo, launch angle, distance, bat speed)? That's
[exit-velo-eval](https://github.com/rader-ai/exit-velo-eval).

---

## Why this exists

**Kids deserve feedback that's true, not feedback that looks impressive.**

A 9-year-old doesn't need a pro scorecard. They need to hear what they did well and the one thing
to try next. A parent needs to know that thing is real. And a coach needs it to match what they'd
say at the cage, not contradict it with a made-up rotation score.

We built this for Swing Dino, and we opened it for the same reason we opened the speed math: if
software is going to coach kids, anyone should be able to read what it says and why.

## Honest on purpose

- **It won't grade what one camera can't see.** A side-on view reads head movement and posture
  well. Hip rotation needs depth a side-on view doesn't
  have, and hand path isn't solid enough yet, so neither is ever scored.
- **Estimates are labeled as estimates.** Stride comes back flagged as not fully reliable from 2D,
  and it counts for less in the overall grade.
- **Trust-weighted grade.** The overall number leans on the clean reads and barely on the shaky
  one. The weights were set on 13 real swings, graded by AI judges working from
  a coaching rubric as stand-ins until a human coach grades them. That's a small sample, and a
  single grade still only loosely tracks a coach's eye, which is why the trend view exists.
- **Changes have to clear the noise.** The trend view compares a hitter's first session to their latest
  and only calls a change when it beats 15% and that hitter's own swing-to-swing wobble. It needs
  two sessions of three or more clean swings before it says anything, and a dip reads as "watch
  this," never "you got worse."

## Built for kids

- **Young mode.** Pass `ageMode: 'young'` for tee-ball and 8-9 hitters and the report drops to the
  three most reliable reads (head, balance, posture) and the headline is all praise. Drills show
  up only on the reads that need work. Never a pro scorecard on a
  6-year-old.
- **Myth-free drills.** Every "work on it" comes with a drill that matches modern coaching. No
  "squish the bug." No "swing down."
- **Punches up, never down.** Headlines lead with a strength, then name one thing to chase.

## The story

A crack that turned out to be the net. A swing that graded 53 or 79 depending on where you started
the clip. A skeleton that jumped from a kid to their parent. [Read how this engine got built](STORY.md),
including the parts where the data told us no.

## How it works, in plain terms

1. **Bring a skeleton.** Any pose source works: Apple Vision, MediaPipe, anything that gives body
   joints per frame. A helper maps Apple Vision's joint names for you.
2. **Find contact.** If you have audio, the bat crack picks the frame nearest contact, corrected
   for how long sound takes to reach the phone. No audio? On a full clip it uses the peak of hand
   speed as a stand-in for contact, a rougher read.
3. **Split the swing.** From contact it looks back for the load and the move to the ball, and
   forward for the finish. The edges come from motion, not fixed timings, so a slow swing and a
   fast one both split right.
4. **Score each read.** Head drift, trunk posture, balance over the base, and stride, each 0 to
   100 against a coaching rubric.
5. **Write the report.** Grades, what good looks like, why it matters, and a drill, in words a kid
   and a parent both get.

## What's inside

| Area | Modules | Does |
|---|---|---|
| Pose to scores | `pose-metrics`, `pose-signals` | Skeleton frames to per-metric scores and raw signals |
| Swing phases | `swing-phases` | Load, launch, contact, and finish from motion |
| Report | `swing-analysis`, `swing-report-stages` | Graded plain-English report, card by card |
| Progress | `mechanics-trend` | Session-over-session change that clears the noise |
| Teaching overlay | `teaching-overlay` | The player's key frames pinned at contact, ready for your own reference overlay, plus the top cue |
| Contact from sound | `audio-detector`, `audio-capture`, `contact-sync` | Bat-crack detection, contact frame, rough contact quality |

Import any module by path: `baseball-swing-analysis/<module>`.

## Build something with it

- A coaching app that gives each kid one real cue instead of a wall of stats
- A progress view that shows mechanics improving across a season
- A slow-mo review tool that jumps straight to the contact frame
- Research that needs a transparent, age-aware grading rubric

You bring the pose data. The engine brings the coaching logic.

## Develop

Needs Node 22.18 or newer (it runs TypeScript directly).

```bash
npm ci
npm test          # 75 tests on synthetic skeletons, no footage needed
npm run typecheck
npm run build     # dist/ with JS and type definitions
```

Issues and pull requests welcome, especially from coaches who think a grade reads wrong. Tell us
the swing and what you'd have said.

## What's not in here

- **No footage.** Every test builds its skeletons in code. No real kids, no real video.
- **No pose model.** Body tracking is platform work you plug in.
- **No remote tuning.** The defaults match what the app ships today. The app can adjust some of
  them remotely, so its values may drift from these over time.

Code comments cite `docs/research/NN`. Those are our internal validation notes and aren't
published; the comment always states the finding it relies on.

## Want it without writing code?

That's [Swing Dino](https://swingdino.com): this engine in an iPhone app, with a report after every
swing that names one thing to work on. Get a swing report this weekend. Join the beta at
[swingdino.com/beta](https://swingdino.com/beta).

## License

MIT. Use it and ship it.
