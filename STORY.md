# How baseball-swing-analysis came to be

On one backyard clip, the loudest crack wasn't the bat. It was the ball hitting the net 110 ms
later.

This is the engine behind Swing Dino's swing report, and the story of how it got built: what we
tried, where the data told us no, and what we still haven't proven. We're telling it because the
"no" parts are the most useful.

## The itch

Swing Dino started with Chris Rader, who has coached youth baseball and softball for years, and a
simple idea about progress: one big swing is luck, and a month of steady ones is a skill. The thing
worth showing a kid isn't a grade against a pro. It's the same kid, getting better.

So when we set out to grade swings from a phone, the question wasn't "how much can we measure?" It
was "how much can we measure *honestly*?"

## Chapter 1: One honesty rule above all

*June 15, 2026*

Early on, we built a knowledge base: a batch of AI researchers working in
parallel, each claim checked against the evidence, coaching myths flagged. The rule that came out
of it runs this whole repo:

> "A single phone camera with 2D pose measures things **in the camera plane** accurately (head
> drift, posture, base, stride, balance, hand path, rotation *order*). It **cannot** measure true
> bat speed, true 3D attack angle, or hip-shoulder separation *in degrees*."

The published pose-tracking research backed it up. Joint angles in the camera's plane hold up
reasonably well. In one pitching study, arm and shoulder
angles off one camera missed by about 20 degrees.

The same research produced the myth list. No "squish the bug." No "swing down." No telling a kid
to literally watch the ball hit the bat: the ball crosses the eye's field faster than the eye can
track it, by a wide margin. And one rule for the youngest hitters:

> "Don't hold a 6-year-old to an MLB swing."

The engine never grades rotation or swing plane for anyone, because a side-on camera can't see
them. Under-11s lose stride too, and get encouragement first.

## Chapter 2: The mic hears contact. And the net.

*June 17, 2026*

A phone has a second sensor most swing apps ignore: the microphone. The crack of the bat pins the
moment of contact, corrected for the few milliseconds sound takes to reach the phone. On synthetic test
audio it landed within 2 ms.

Real backyard footage broke the obvious version. On one clip, the loudest crack wasn't contact. It
was the ball hitting the net's metal frame 110 ms later.

Loudness doesn't mean contact. When the ball's flight is tracked, the engine picks the crack
nearest the moment the ball leaves the tee. With sound only, it takes the earliest crack and
marks it low confidence. Never the loudest.

A nice surprise fell out of it: the gap between the bat crack and the net ping, over a known
distance, is its own speed estimate. On that clip the sound said about 37 mph. The camera,
completely independently, said 36 to 37.

## Chapter 3: The window is everything

*June 2026*

Our first version graded the whole clip: the walk-up, the swing, and the settle afterward. A young
hitter's swing scored 53. Graded only from load to finish, the same swing scored 79.

> "The window is everything."

That became the #1 fix, and it's why the engine finds contact first and builds the swing phases
outward from there, using motion instead of fixed timings.

## Chapter 4: The engine said great. The judges said "standing up."

*June 19, 2026*

To check the grades we needed a reference. We didn't have a human coach grading yet, so we built
the loop with AI judges as stand-ins: two vision models grading still frames independently
against the coaching rubric.

On 13 real tee swings, the judges flagged the same flaw on all 13: standing up out of the hinge at
contact. Our engine had graded that posture 83 to 94. Great. Head stillness was pegged at nearly
100 on every swing.

We tuned it. The worst stand-up swings dropped from 85 to around 40, and the grades finally spread
out. Then the honest part of the write-up:

> "Engine-vs-judge correlation did NOT improve."

Round two found something worse. Sampling 30, 40, or 48 frames from the same swing gave posture
scores of 60, 35, and 50. Same swing. We switched to measuring over percentiles instead of single
frames, and the same swing went from 60, 35, 50 to 68, 67, 50. Better,
not solved.

## Chapter 5: You can't tune in a signal that isn't there

*June 25, 2026*

With 16 swings graded by the AI judges, we measured how well each read tracked them. Posture
tracked a little (+0.29). Head and balance barely tracked at all.

> "Tuning the dials lifted agreement to ~44% but **could not create correlation that isn't there**."

We stopped pretending. The engine's grade weights have been frozen since, pending a real coach, and
the web version moved to grading posture only and flagging the rest.

## Chapter 6: The parent in the frame

*July 2, 2026*

A second audit traced our worst readings to something no rubric would catch. On clips where a parent was
standing near the tee, the pose tracker jumped between the two people. One "76% of body height head
lunge" was just the skeleton hopping from the kid to the adult. Sometimes it blended both into one
body.

A subject-tracking guard now keeps one person through the swing. On those clips it shrank the
range of fake head-drift readings from 29% of body height to 10%. It can't yet fix a skeleton
blended from two people.

## Chapter 7: Stop competing with a coach's report card

*July 4, 2026*

After all of that, the conclusion was plain: one absolute grade from one phone will not match a
coach's eye. So we stopped trying to.

> "Stop competing with a coach's report card. Own the thing no coach can do: the longitudinal
> record … A coach sees a swing; we see every swing since June."

Same kid, same setup, same pipeline: the built-in biases are the same every time, so they cancel out when
you compare a kid to themselves. That's the trend view. It won't call a change until a hitter has
at least two sessions of three or more clean swings, and the change beats both 15% and that
hitter's own swing-to-swing wobble. A dip gets a gentle "watch" note and a drill, never a shame line.

## The drills

Every "work on it" comes with a drill from a myth-checked library, and the coaching behind them
traces to public sources: Little
League University, Driveline, pro instructors' fault-fix videos, and NFCA softball clinics. The
evidence behind the kid rules is published research, including the finding that hip-shoulder
separation shows up with age, around 10 or 11, and that kids learn better from outside-the-body
cues ("hit it to the fence") than body-part cues ("rotate your hips").

## Where it stands today

- **No human coach has graded our reference set yet.** Every grade we've tuned against came from AI
  judges. That's the biggest open item.
- **What we trust:** contact timing from sound, swing-window trimming, the key frames, the
  one-person tracking guard, and the trend view's noise gates.
- **What we don't claim:** that a single grade matches a coach, or anything a side-on camera can't
  see.

## Why we opened it

Software that coaches kids should be readable by the parents and coaches of those kids. Opening it
means anyone can check what it says and why, and every chapter above is a place where checking the
work changed the answer.

## Help us close the gap

**Coaches, we want you.** Grade a swing, tell us what you'd have said, and tell us where the engine
got it wrong. Open an issue with your read and the setup. That's the data this project needs most.

If you want a swing report on your kid this weekend, that's Swing Dino. Join the beta at [swingdino.com/beta](https://swingdino.com/beta).
