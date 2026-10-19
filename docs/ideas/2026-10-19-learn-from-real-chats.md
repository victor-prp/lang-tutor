# Idea: learn from real chats

- **Status:** parked on 2026-10-19. Too early: there are no real users yet.
- **Revisit when:** there are real users, and either they ask for help with their own chats or
  Victor finds himself sharing WhatsApp messages into the app every day.
- **Research:** a competitive landscape and the integration routes, researched on 2026-10-19.
  The findings are summarised below; the full report was not kept.

## The idea

A learner chats in Italian with real people on WhatsApp, Telegram and the rest, and the app helps
them learn from those chats. They tap a word they don't know in a message they received, the way
they tap a word on a sentence card, and get help writing their own reply correctly.

## Translation is not learning

WhatsApp, Telegram, Apple, Samsung and Pixel already translate messages for free. Victor tried it
on 2026-10-19: "it works and good for communication. But it useless for learning." Three reasons:

- **The whole sentence arrives at once.** The learner never tries the Italian first, so nothing is
  retrieved and nothing sticks.
- **Nothing is remembered.** The same word is translated again tomorrow as if it were new. It never
  reaches the learner's words, and it never comes back for review.
- **Writing is skipped.** WhatsApp's Writing Help and Telegram's AI Editor write the sentence for
  the learner, fix it without saying why, or translate it from Hebrew.

What makes a tap teach in this app is what happens after it: the tap is recorded, a practised word
that had to be looked up takes a miss, and the word comes back for review. A chat feature is a
learning feature only if it feeds that loop.

## What already exists (October 2026)

Nothing found does all three: work in the learner's real chats, a tap on one word that is saved for
review, and an explained correction of their own sentence.

- **Messengers and phones:** translate a whole message or chat, never one word, and save nothing.
  Hebrew is missing from every on-device translator found (WhatsApp, Apple, Samsung, Pixel).
- **Tutor bots on WhatsApp and Telegram** (Parlai, Polyato): correct and explain, but the learner
  chats with the bot, not with a friend.
- **HelloTalk and Tandem:** real people, but only strangers inside their own apps, and translation
  is rationed (10 and 3 a day free).
- **Instant Translate On Screen:** an Android overlay with 5M+ installs that saves words from
  WhatsApp chats into flashcards. You drag a bubble over the text, and it explains nothing. The
  product to benchmark against.
- **Tokki:** friends tap words in their chat and build its vocabulary, but in Tokki's own
  messenger, with about 300 users and no writing help.
- **Grammar checkers** (Grammarly, LanguageTool, DeepL Write): none supports Hebrew. Nothing
  explains an Italian mistake in Hebrew.

## How it could reach the chats

- **WhatsApp:** no allowed way for an app to read personal chats. Unofficial clients break its
  terms and risk bans. Since 15 January 2026 its business platform bars bots whose main product is
  AI, and Israel is outside the regional exceptions.
- **Telegram:** the one network whose rules allow deep integration, as a third-party client or a
  Business bot. Clause 1.5 of its API terms forbids using Telegram data to deploy AI, so it needs a
  ruling from Telegram before anything is built on it.
- **What works everywhere:** the phone's own features. The learner shares or copies a received
  message into the app, and a keyboard or a screen in the app helps with the reply.
- **Checked on 2026-10-19:** WhatsApp on Android does not let you select a single word inside a
  message, so an entry in the text-selection menu is out. A message has to be shared or copied
  whole, and the word is tapped inside the app. iOS and Telegram are not checked.

## The shape to build first

Inside this app, not as a separate messenger product, so it is tested on Victor first.

1. **Share a message into the app.** In WhatsApp: long-press, Share, pick the app. The app shows
   the message as a tappable sentence with its word map. A tapped practised word takes a miss, and a
   tapped new word is offered for My words, like the photo flow's "what to do with the new words".
   This reuses `TappableSentence`, the word map and the tap rules of phases 59 and 62. The app has
   no share target yet.
2. **Check my sentence.** The learner writes the reply in Italian, the app marks each mistake and
   explains it in Hebrew, then the learner copies it back. Mistakes they make again and again feed
   their practice.

## Open questions

- Is an explanation of Italian grammar in Hebrew good enough? It has to be measured with evals,
  not assumed: one study found a model's grammar explanations change with the prompt's language.
- Does a shared message carry enough context for a good word map, or does it need the message
  before it?
- Can a single word be selected in a WhatsApp or Telegram message on iOS?
- Does Telegram's clause 1.5 cover a translation or a correction the user asks for?
