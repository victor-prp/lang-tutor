# Nightly-QA triage rules

Applied in order. The first rule that matches decides. Changes to this file go through a PR.

The current UI is temporary and a real one will replace it. A complaint that the
temporary UI would only answer by being redesigned is not worth fixing now.

## 1. duplicate → closed, "Duplicate of #N"

Another **open** issue shows the same **behaviour**. A matching fingerprint is only a
hint: `dictionary | senses list | wrong-content` matched unrelated issues three times
(#61, #58, #47). Confirm the behaviour, not the fingerprint.

Point at the **oldest** open issue with that behaviour, and check across screens: #65
(home) and #31 (login) are the same lost session.

## 2. working-as-intended → closed, `by-design`

The behaviour is deliberate, a code comment, spec or commit records it, the outcome is
correct, and the complaint asks for a **different design**. You must cite where the
decision is recorded. No citation, no rule 2.

Not this rule when the design is fine but the screen explains it poorly — that is
ux-polish (#53, #56).

## 3. real_bug → open, fix as soon as possible

Either:

- **code is wrong about data or a contract**, whichever side it lives on — for example
  the client handles fewer values than the shared schema allows (#61). A future UI would
  have to handle the same values, so a redesign does not make it go away; or
- **a reproducible server error (5xx), whatever the input** (#55). Our own failure must
  not look like an outage.

A correct 4xx with a vague message is not this rule (#45).

## 4. translation_quality → open

The model's output is wrong or malformed: spelling, near-duplicate senses, sense ranking,
an example that does not show its sense (#58, #35, #32, #30). Waits for a dedicated
translation-quality effort.

## 5. missing-feature → open

Only building something that does not exist yet would meet the complaint (#31 session
persistence, #51 a larger word pool, #28 saving a chosen sense).

## 6. ux-polish → open, `known-issue`

The default. The app works, the data is right, the screen is workable; the complaint is
about labels, wording, feedback timing, cross-screen consistency, or odd input handled
imperfectly. These wait for the real UI.
