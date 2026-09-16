# QA agent findings

Two proof-of-concept sessions, 2026-09-16, persona `careful-adult`, focus `polysemy`.
Both drove the real web app in a real browser against the real Gemini API.

Screenshots referenced below as `shots/<name>.png` are kept in `nightly-qa/evidence/`.
They come from the clean run only: the planted run cited two images that were never
written, because the screenshot tool silently writes nothing when handed a path with a
directory in it. The brief now asks for a bare filename and the validator names any cited
image that is not on disk.


## Clean tree (the real app)

Covered: signed up as a new Hebrew-speaking learner and completed onboarding; looked up a concrete noun/verb word with multiple unrelated senses in the dictionary; looked up a word whose sense list contained a repeated meaning; looked up an idiomatic phrase; looked up an abstract verb with genuinely distinct senses; looked up a deliberately misspelled word to see typo handling; used the direction-swap control in the dictionary, with matching and mismatched input language; marked a chosen meaning as the one intended, and checked whether it was actually persisted; played a full 10-question practice session end to end, including a correct and an incorrect answer, and reached the results screen; re-navigated to the app's home route while logged in to check session handling

### bug / high — "Save this meaning" claims success but never calls the server

**Screen:** dictionary

**Steps**

1. Log in and open the dictionary (תרגום)
1. Type a word with multiple senses, e.g. 'bank', and submit
1. Click 'זו המשמעות שחיפשתי' (this is the meaning I meant) under the top sense
1. Watch the network log from the moment of the click

**Expected:** Clicking the button persists the chosen sense to the user's vocabulary (the app itself displays the message 'התרגום נשמר לאוצר המילים שלך' — the translation was saved to your vocabulary), which should involve a request to the server.

**Observed:** The UI shows the saved confirmation message and disables/replaces the button, but no network request is issued at all — the only API calls in the log remain the earlier POST /api/users and POST /api/translations. Nothing is sent to record the choice.

**Network:** After clicking the choose-meaning button, browser_network_requests shows no new request; the last POST is still the original POST /api/translations that returned the sense list. No POST/PUT to any vocabulary or choice endpoint occurs.

**Fingerprint:** `dictionary | mark-meaning action | success message shown with no corresponding network call`

---

### bug / high — Swapping translation direction resubmits box text unchanged and crashes the server (502) when it doesn't match the new source language

**Screen:** dictionary

**Steps**

1. Open the dictionary and translate an English word, e.g. 'recieve' (English→Hebrew, the default direction)
1. Without changing the text box, click '⇄ החלף' to swap to Hebrew→English
1. Observe the result panel and check the network log for the resulting request

**Expected:** Either the app clears/adapts the input for the new direction, or it declines to resubmit English text as if it were Hebrew, or it shows a graceful validation message.

**Observed:** The app immediately re-POSTs the same English text with direction 'he_en' ({"text":"recieve","direction":"he_en"}). The server responds 502 Bad Gateway, a console error is logged, and the UI shows a generic 'התרגום לא זמין' (translation unavailable) with a retry button. As a control, swapping direction after typing genuine Hebrew text (e.g. 'בנק') works correctly and returns valid English senses, confirming the crash is specific to the language/direction mismatch left over from the swap.

**Network:** POST http://localhost:3101/api/translations with body {"text":"recieve","direction":"he_en"} => 502 Bad Gateway

**Console:** Failed to load resource: the server responded with a status of 502 (Bad Gateway) @ http://localhost:3101/api/translations:0

**Fingerprint:** `dictionary | direction swap | stale input text resubmitted under new direction causes server 502`

---

### bug / medium — Navigating directly to the app's home route while logged in bounces back to the login screen

**Screen:** home

**Steps**

1. Log in and complete any action, e.g. finish a practice session
1. Navigate (full page load) to http://localhost:8092/
1. Observe which screen loads

**Expected:** The home screen loads showing the logged-in user's practice/dictionary entry points, since the session was valid moments before (other routes such as /translate load fine without re-login in the same conditions).

**Observed:** The app redirects to /login instead of showing home. The username field is pre-filled, and clicking 'כניסה' (no password required) logs back in immediately and returns to a working home screen. No network request accompanies the redirect to /login — it happens purely client-side. Re-navigating directly to /translate right after login does not trigger this redirect, only '/' does.

**Network:** browser_network_requests shows zero requests around the navigation to '/', confirming the redirect to /login is a client-side decision, not a rejected server session check.

**Screenshots:** shots/f_home_redirect_login.png

**Fingerprint:** `home | route navigation | direct load of root path forces re-login despite valid session`

---

### bug / medium — One word's sense list contains two entries with the identical translation and part of speech, undifferentiated

**Screen:** dictionary

**Steps**

1. Open the dictionary and translate the word 'light'
1. Expand 'עוד משמעויות' to see all returned senses
1. Compare the Hebrew translation and part-of-speech tag across all noun senses

**Expected:** Each listed sense represents a distinct meaning the learner needs to tell apart, as is the case for the other senses of this same word (adjective 'light' by weight vs. by color are correctly kept separate, and the verb sense is separate again).

**Observed:** Two of the five senses returned are both translation 'אור', part of speech 'noun' — one exemplified by 'The light in the room was dim' and the other by 'Please turn off the light when you leave.' Both sentences use 'light' in exactly the same sense (illumination); the app presents them as two different senses with no indication of how they differ, effectively duplicating one meaning in the list.

**Network:** POST /api/translations for {"text":"light"} returned senses including {"translation":"אור","part_of_speech":"noun",...} twice, with only the example sentence differing between the two entries.

**Screenshots:** shots/f_light_top.png, shots/f_light_expanded.png

**Fingerprint:** `dictionary | senses list | two senses share identical translation and part of speech`

---

### inconvenience / high — All but the top sense are hidden behind "more meanings" even though the server already returned them

**Screen:** dictionary

**Steps**

1. Open the dictionary and translate any word that has more than one sense, e.g. 'bank', 'light' or 'run'
1. Observe the result panel immediately after the translation loads
1. Check the network response for the same request

**Expected:** Since all senses were already delivered in the single API response (no extra loading needed), a learner comparing meanings would want to see them together, or at least a compact preview of each, rather than an extra click that reveals data already on the device.

**Observed:** Only the single 'top' sense is shown, with the remaining senses fully hidden behind a 'עוד משמעויות (N)' button, despite the JSON response already containing every sense's translation, part of speech and example. This reproduced on every multi-sense word tried (bank: 4 senses, light: 5 senses, receive: 4 senses, run: 5 senses) — one interaction pattern, not one problem per word.

**Network:** POST /api/translations for 'bank' returned all 4 senses in one 200 response; the UI rendered only the first sense until 'עוד משמעויות (3)' was clicked.

**Screenshots:** shots/f_light_top.png

**Fingerprint:** `dictionary | senses list | only the top sense shows before an extra tap despite full data already delivered`

---

**Not covered:** Did not explore: changing/incorrect profile data (age/name validation limits), practice session content beyond one full 10-question run, behavior with very long input or non-English/non-Hebrew scripts in the dictionary box, or repeated 'weird' cases of navigating to other deep routes to map exactly which ones survive the client-side session check described in f3. The login flow itself (username only, no password) was not evaluated as a security question since the persona and task are focused on usability/dictionary content, not auth hardening.


## Planted defect (reveal button suppressed)

Covered: signed up as a new user through onboarding (username, name, age, native=Hebrew, target=English); looked up single words with multiple senses in the dictionary: bank, light, set; looked up an idiom phrase: kick the bucket; looked up a full sentence containing an ambiguous word: I saw her duck under the table.; looked up a deliberately misspelled word: recieve; used the direction-swap (⇄) control on an existing result; chose a meaning with "זו המשמעות שחיפשתי" and watched the network log for a save call; checked the profile screen for saved-vocabulary data; checked the home screen for any vocabulary/history list; played a full 10-question practice session, including one deliberately wrong answer, through to the results screen; checked console logs for errors across the session; triggered a full page reload/navigation to see whether the session survives it

### bug / high — "Saved to vocabulary" confirmation shown after choosing a meaning, but no request is sent to the server

**Screen:** dictionary

**Steps**

1. Open the dictionary (תרגום מלה או ביטוי)
1. Type any word, e.g. "set", and submit
1. Open the network log and clear/note the current requests
1. Click "זו המשמעות שחיפשתי" (this is the meaning I was looking for)
1. Observe the on-screen text that appears and compare it against the network log for the same period

**Expected:** Choosing a meaning that the app says was "saved to your vocabulary" (התרגום נשמר לאוצר המילים שלך) to result in some server call that persists it, so it can later be reviewed or practiced.

**Observed:** The button click only changes local UI state (shows the confirmation text and swaps the button for "מלה חדשה"/new word). No new network request of any kind fires when the button is clicked — the network log shows the same requests before and after the click.

**Network:** Before click: last request is POST /api/translations (index 16, the lookup for "set" reversed). After clicking translate-choose, browser_network_requests still lists only up to index 16 — no new request appears.

**Screenshots:** shots/saved-no-network.png

**Fingerprint:** `dictionary | choose-meaning action | confirmation text shown with no corresponding network call`

---

### bug / high — Dictionary result only ever shows one sense, even when the server returns several genuinely different ones

**Screen:** dictionary

**Steps**

1. Open the dictionary and look up a word with several distinct meanings, e.g. "bank" or "set"
1. Read the result card and note it shows exactly one translation, part of speech and example, under the heading "המשמעות הנפוצה" (the common meaning)
1. Inspect the network response for the same lookup

**Expected:** Either all senses returned by the server are shown (perhaps with the common one first), or there is some visible way (a "more meanings"/"other senses" control) to reach the rest, since the word clearly has more than one common English meaning (e.g. "bank" = financial institution / riverbank / to deposit / to rely on).

**Observed:** For "bank" the server returned 4 senses (noun "בנק", verb "להפקיד בבנק", noun "גדה", verb "לסמוך"), but the screen shows only the first one, with no button, link or indicator that other senses exist. The same happened for "light" (5 senses returned, 1 shown) and "set" (5 senses returned, 1 shown). This reproduced on every polysemous word tried; no word surfaced more than one sense in the UI.

**Network:** POST /api/translations for "bank" returned senses: [noun בנק, verb להפקיד בבנק, noun גדה, verb לסמוך]; the rendered card shows only the first (בנק). Same pattern confirmed for "light" (5 senses returned, 1 rendered) and "set" (5 senses returned, 1 rendered).

**Screenshots:** shots/bank-translate.png

**Fingerprint:** `dictionary | senses list | only the first sense renders, no way to reach the rest`

---

### bug / medium — Dictionary can return two near-duplicate senses for the same word with no distinguishing information

**Screen:** dictionary

**Steps**

1. Open the dictionary and look up "light"
1. Inspect the full network response (not just what renders on screen)

**Expected:** Each sense in the response should represent a genuinely distinct meaning, since the list is meant to help a learner tell the meanings of a word apart.

**Observed:** The response for "light" contains two separate senses that are both the noun "אור" (illumination), differing only in their example sentence ("The light in the room was dim." vs "Please turn off the light when you leave.") — not a distinct meaning from each other. This sits alongside three genuinely different senses (adjective "light"=קל/not heavy, verb "to light"=להדליק, adjective "light"=בהיר/pale colour), so the duplication looks like a data-generation slip rather than an intentional repeat.

**Network:** POST /api/translations {"text":"light"} response senses[0] and senses[3] both have translation "אור" / part_of_speech "noun", with only the example differing.

**Fingerprint:** `dictionary | senses list | two senses share the same translation and part of speech`

---

### weird / medium — Swapping translation direction re-submits the same Latin-script text as if it were Hebrew, with no notice that it was reinterpreted

**Screen:** dictionary

**Steps**

1. Open the dictionary and look up an English word, e.g. "set" (direction shows "מאנגלית לעברית")
1. Without changing the text box, click "⇄ החלף"
1. Wait for the new result and read it

**Expected:** Either the text box is cleared so the learner can type a Hebrew word, or, if the same text is resent, the app tells the learner it reinterpreted their English spelling as a Hebrew word (the way it does for a misspelled English word, e.g. typing "recieve" shows "לא מצאנו את recieve — מציגים תוצאות עבור receive").

**Observed:** The input box still shows the Latin text "set", the direction label changes to "מעברית לאנגלית" (Hebrew→English), and the app silently resubmits {"text":"set","direction":"he_en"}. The server guesses this means the Hebrew loanword סט and returns an English result ("set, collection") with a Hebrew example sentence. Nothing on screen tells the learner their English spelling was reinterpreted as a Hebrew word, unlike the typo-correction banner used elsewhere in the same screen.

**Network:** POST /api/translations request body {"text":"set","direction":"he_en"}; response senses[0].translation = "set, collection", example.source is Hebrew (קניתי סט חדש של כלי אוכל.), example.target is English.

**Fingerprint:** `dictionary | direction swap | same script resent under new direction with no reinterpretation notice`

---

### weird / low — A full page navigation/reload logs the user out even though login only needs a username

**Screen:** login

**Steps**

1. Sign up or log in normally and reach the home screen
1. Navigate the browser directly to http://localhost:8092/ (a full reload rather than in-app navigation)
1. Observe the resulting screen

**Expected:** Either the session survives a reload (since the app already ran through onboarding), or, if it does not, the login screen should behave consistently with a real auth step.

**Observed:** The app returns to /login. The username field is pre-filled with the last used username, and clicking "כניסה" with no password logs back in immediately. So the app has no real session persistence across reloads, but also no real authentication (no password) — the login screen exists but is not protecting anything.

**Network:** POST /api/login {"username":"victor_qa"} => 200, no password field ever appears in the onboarding or login forms

**Fingerprint:** `login | session persistence | reload clears session but username-only login trivially restores it`

---

### inconvenience / medium — No screen anywhere shows the vocabulary the app claims to have saved

**Screen:** home

**Steps**

1. In the dictionary, look up a word and click "זו המשמעות שחיפשתי" so the app says the translation was saved to your vocabulary
1. Go back to the home screen and look for a list of saved words
1. Open the profile screen and look for the same

**Expected:** Some way to see the words saved to "אוצר המילים שלך" (your vocabulary), since the app explicitly names that collection when confirming a save.

**Observed:** Home screen only offers "התחל" (start practice) and the dictionary entry point; the profile screen only shows the signup details (username, name, age, native/target language). Neither screen lists or links to saved vocabulary.

**Fingerprint:** `home/profile | saved vocabulary | no screen exposes the collection the app names`

---

**Not covered:** Typo correction (recieve -> receive) and the idiom lookup (kick the bucket) worked well and are not included as findings. The practice session (10 questions, one deliberate wrong answer, results screen with a 'review these' list) worked correctly with clear right/wrong visual feedback and no console errors. Did not explore: what happens with an empty/whitespace query, extremely long input, or a phrase that mixes Hebrew and English; did not test multiple accounts or the 'switch user' button beyond seeing it exists; did not confirm whether vocabulary is persisted anywhere server-side under a different endpoint than /api/translations, since no UI surface exists to check it and reverse-engineering the API further felt out of scope for a user-perspective session.

