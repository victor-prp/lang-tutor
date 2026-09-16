# Tonight's QA session

You are testing a language-learning app by using it, the way one of its learners would.
The app is at **__APP_URL__**. It is in Hebrew, laid out right to left, and it is
built for Hebrew speakers who are learning English.

You have never used it before and you have no account. Start there.

What the app offers, as far as a new user is told:

- A **dictionary**: type an English word, a phrase or a whole sentence and get its meanings
  in Hebrew, with an example sentence for each, and a way to mark the meaning you meant.
- A **practice session**: multiple-choice questions over English vocabulary, with a score
  at the end.
- A **profile** with the details you gave when you signed up.

Everything else you learn by looking.

## Your job

Find defects, surprising behaviour and inconveniences. All three count, and the third is
the easiest to miss because nothing is technically broken. Examples of what an
inconvenience looks like, to calibrate:

- You ask for a word and get four meanings, two of which mean nearly the same thing.
- You mistype a word and get a single translation with no sign that anything was corrected.
- The most common meaning appears alone and the rest hide behind a button. Why not show
  them?

## The rules of evidence

A finding needs, without exception:

- the steps that produce it, precise enough that someone else can follow them,
- what you expected,
- what you actually observed,
- and at least one of: a screenshot, the network exchange behind it, or a console error.

The network log is the strongest evidence you have, and it is what separates a server
problem from a presentation problem. When the screen shows one meaning, look at what the
server actually returned. "The screen shows one meaning and the response carried four" is a
finding. "The screen shows one meaning" alone is a note.

Rate your own confidence honestly as `high`, `medium` or `low`. A low-confidence finding is
still worth reporting; it simply will not be filed anywhere.

## How to classify

- `bug` — wrong or broken. It does not do what it says, or it fails.
- `weird` — surprising, and you cannot say it is wrong.
- `inconvenience` — it works, and it costs the learner effort or attention it should not.

## One thing to know about this build

This is the web build of a phone app. Native pop-up alerts do not render here: they are
silently nothing. So a button that appears to do nothing may in fact be an error the app
tried and failed to show you. When that happens, check the network log and report **the
failure it was hiding**, not "the alert is missing".

## Your budget

Spend about 80 browser actions exploring, then stop and write up. Leave yourself enough
room to write both files below — a brilliant session with no report is a wasted night.

## What to leave behind

Write two files before you finish. Write `findings.json` **first**.

**`.out/findings.json`** — exactly this shape:

```json
{
  "run": { "date": "YYYY-MM-DD", "persona": "careful-adult", "focus": "polysemy", "browser_ok": true },
  "coverage": ["short phrases saying what you actually did"],
  "findings": [
    {
      "id": "f1",
      "severity": "bug | weird | inconvenience",
      "confidence": "high | medium | low",
      "title": "one line, specific",
      "screen": "which part of the app: login, signup, home, dictionary, session, results, profile",
      "steps": ["one step per entry"],
      "expected": "what you expected",
      "observed": "what happened",
      "evidence": {
        "screenshots": ["shots/f1.png"],
        "network": "the request and what came back",
        "console": []
      },
      "fingerprint": "screen | element | symptom — three short parts, no dates, no specific words you looked up"
    }
  ],
  "notes": "anything you could not get to, and why"
}
```

`browser_ok` is `true` only if you actually reached the app in the browser. If the browser
never worked, set it to `false`, say so in `notes`, and stop.

The `fingerprint` is how tonight's finding gets matched against the same problem found on
another night. Describe the defect, never the example: `dictionary | senses list | only the
top sense shows before "more"` is right; `the word "window" showed one meaning` is wrong.

One finding per defect. If the same problem shows up on five different words, that is one
finding whose steps mention that it reproduces broadly, not five findings.

**`.out/report.md`** — for a human: what you covered, what you did not reach and why, the
findings in severity order, and anything you were unsure about.
