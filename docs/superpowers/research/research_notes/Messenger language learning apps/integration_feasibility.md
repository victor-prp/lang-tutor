# Messenger integration feasibility for a language-learning chat helper (status as of 2026-10-19)

Product being evaluated: an app that hooks into WhatsApp, Telegram and other messengers so a learner can tap a word in a **received** message to translate it, and get help writing their **own** message before sending it.

## WhatsApp: Business Platform vs personal accounts, the AI-chatbot ban, unofficial libraries, DMA interoperability

### Takeaway
No sanctioned route lets a third party read a person's own WhatsApp chats. The official Business Platform only carries messages that people send to a business number. From 15 Jan 2026 it also bans companies whose main product is an AI assistant, but competition regulators have since forced exceptions in Italy, Brazil and the EU. Unofficial linked-device libraries break WhatsApp's consumer Terms. DMA interop exists in the EU, but only for a full rival messenger (1:1 chats only, E2EE required), not for a plug-in that reads a user's existing chats.

### Cited Findings
**Official Business Platform (Cloud API) and its AI-provider clause**
- The Meta Terms for WhatsApp Business Platform (page "Last Modified: September 23, 2026"), Section 4.7: "Providers and developers of artificial intelligence or machine learning technologies, … are strictly prohibited from accessing or using the WhatsApp Business Platform, whether directly or indirectly," when such technology is the *primary* functionality offered. The section also says "certain countries may be excepted" under a linked list, and "you may retain an AI Provider as your Solution Provider." — [Meta Terms for WhatsApp Business Platform](https://www.facebook.com/legal/Meta-Terms-for-WhatsApp-Business-Platform)
- The same Section 4.7 bars using WhatsApp Business Platform Data (including anonymised, aggregate or derived forms) "to create, develop, train, or improve any machine learning or artificial intelligence systems". It allows fine-tuning a model "that is for your exclusive use". — [Meta Terms for WhatsApp Business Platform](https://www.facebook.com/legal/Meta-Terms-for-WhatsApp-Business-Platform)
- Timeline: the terms applied to new Business API users from 15 Oct 2025 and to all existing users from 15 Jan 2026. Named casualties include ChatGPT, Perplexity, Luzia and Poke, and OpenAI confirmed ChatGPT would leave WhatsApp. Customer-service, booking, order-tracking and sales bots remain allowed, and Meta decides what counts as "primary". — [respond.io](https://respond.io/blog/whatsapp-general-purpose-chatbots-ban); [9to5Mac](https://9to5mac.com/2025/10/20/whatsapp-bans-ai-chatbots-from-using-its-business-api/); [Gulf News](https://gulfnews.com/technology/no-more-chatgpt-and-perplexity-on-whatsapp-meta-bans-major-ai-chatbots-from-2026-1.500316016)
- respond.io's reading of the rule: open-domain assistants and "conversation companions" are banned, while bots "ancillary to a legitimate business service" are allowed. The article does not classify a specialised AI tutor or a translation bot. — [respond.io](https://respond.io/blog/whatsapp-general-purpose-chatbots-ban)

**Regulators pushing back (each carve-out is regional)**
- **Italy, 24 Dec 2025:** the AGCM imposed interim measures ordering Meta to "immediately suspend the WhatsApp Business Solution Terms" to keep the platform open to rivals of Meta AI. Meta called the decision "fundamentally flawed" and said it would appeal. — [AGCM press release](https://en.agcm.it/en/media/press-releases/2025/12/A576); [Malay Mail/Reuters](https://www.malaymail.com/news/money/2025/12/24/italy-antitrust-regulator-orders-meta-to-drop-whatsapp-terms-blocking-rival-ai-chatbots/203095)
- **Brazil, 15 Jan 2026:** Meta exempted +55 numbers after CADE opened a case. In March 2026 CADE rejected Meta's appeal. Meta then allowed rival AI chatbots in Brazil **for a fee of $0.0625 per "non-template message"** from 11 Mar 2026. Developers called the price high and were hesitant to return. — [TechCrunch, 15 Jan 2026](https://techcrunch.com/2026/01/15/after-italy-whatsapp-excludes-brazil-from-rival-chatbot-ban); [TechCrunch, 6 Mar 2026](https://techcrunch.com/2026/03/06/after-europe-whatsapp-will-let-rival-ai-companies-offer-chatbots-in-brazil/)
- **EU:** the Commission opened a case in Nov 2025 and issued a Statement of Objections in Feb 2026. Meta offered paid access in March 2026 and free access for one month in May. On **9 Jun 2026** the Commission ordered interim measures: Meta must restore rival AI assistants' access, and the Commission said a fee "is in practice equivalent to the previous access ban". Compliance was due within five working days. The measures last until the investigation ends or June 2029. Meta said it will appeal. — [AP via News4Jax](https://www.news4jax.com/business/2026/06/09/eu-orders-meta-to-restore-whatsapp-access-for-rival-ai-chatbots/); [Morningstar/Dow Jones](https://www.morningstar.com/news/dow-jones/202606095215/meta-gets-eu-antitrust-order-to-open-whatsapp-to-rival-ai-chatbots); [The Star](https://www.thestar.com.my/tech/tech-news/2026/06/10/eu-orders-meta-to-restore-whatsapp-access-for-rival-ai-chatbots)
- One report says the order requires access "under the same terms and conditions that were in place before 15 October 2025". The AP and Dow Jones reports I read do not confirm that wording. — [Hoodline (AI-assisted outlet)](https://hoodline.com/2026/06/brussels-smacks-meta-orders-whatsapp-to-reopen-to-rival-bots/)

**Personal accounts: the consumer Terms**
- WhatsApp Terms of Service (EEA), "Effective August 17, 2026", under "Harm to WhatsApp or Our Users", forbid:
  - accessing the Services "through automated or other means" in unauthorised ways;
  - reverse engineering;
  - preparing "derivative works";
  - collecting "information of or about our users in any impermissible or unauthorized manner";
  - creating "software or APIs that function substantially the same as our Services" for third parties.

  — [WhatsApp Terms of Service (EEA)](https://www.whatsapp.com/legal/terms-of-service-eea)

**Unofficial libraries (Baileys, whatsapp-web.js, whatsmeow/mautrix)**
- Baileys calls itself "a WebSockets-based TypeScript library for interacting with the WhatsApp Web API". Its disclaimer says it is "not affiliated, associated, authorized, endorsed by … WhatsApp" and that its authors "do not in any way condone" ToS violations. It discourages "stalkerware, bulk or automated messaging". Breaking changes arrived in 7.0.0. — [Baileys on GitHub](https://github.com/WhiskeySockets/Baileys)
- The mautrix-whatsapp docs:
  - the bridge links as a WhatsApp linked device (QR code or 8-letter pairing code) and "uses the web API";
  - linked devices disconnect if the phone is offline for more than two weeks;
  - "WhatsApp is known to ban accounts that are too suspicious. Just using the bridge shouldn't cause any bans", but bans grow more likely when combined with emulators, VoIP numbers, new accounts or DMs to non-contacts.

  — [mautrix-whatsapp authentication docs](https://docs.mau.fi/bridges/go/whatsapp/authentication.html)
- I found no official Meta statement naming Baileys or whatsapp-web.js, and no documented ban wave aimed at them in 2025–2026. Secondary sources agree that use on a personal number risks the ToS and a ban, and that behaviour drives detection more than the library does. — [checkleaked library comparison](https://whatsapp.checkleaked.cc/es/blog/best-open-source-whatsapp-libraries); [zylos.ai](https://zylos.ai/research/2026-01-26-whatsapp-api-automation)
- A related case: from Sep 2025 Meta stopped some accounts from creating any linked-device session for a third-party message-archiving tool, and lifted the block on 4 Feb 2026. This comes from a search snippet; the page returned 403 when fetched. — [Intradyn](https://www.intradyn.com/whatsapp-blocked-linked-device-archiving/)
- In Aug–Sep 2026 WhatsApp wrongly suspended many legitimate accounts, which Meta blamed on a technical error. Meta lists "unusual usage patterns" among the triggers for suspension. — [The Star, 3 Oct 2026](https://www.thestar.com.my/news/nation/2026/10/03/meta-admits-technical-error-caused-wrong-whatsapp-account-suspensions-says-mcmc)

**EU DMA messaging interoperability ("third-party chats")**
- Meta published the WhatsApp Reference Offer on 6 Mar 2024 and the Messenger Reference Offer on 6 Sep 2024.
  - Providers sign an agreement and meet technical and security criteria.
  - Meta must enable interop within three months of a request.
  - Meta prefers the Signal Protocol and accepts others with equivalent guarantees.
  - Third-party clients connect directly to WhatsApp servers over an XMPP-based protocol with Noise handshakes and authenticate with an OpenID/JWT-style token.
  - Third parties host their own media.
  - Year one covers 1:1 text and media; groups and calling come later.

  — [Meta Engineering](https://engineering.fb.com/2024/03/06/security/whatsapp-messenger-messaging-interoperability-eu/)
- 14 Nov 2025 launch:
  - BirdyChat and Haiket are the first partners.
  - Chats are 1:1 with text, images, voice, video and files; groups come "once our partners are ready".
  - Android and iOS only.
  - Users opt in from Settings and can choose a unified inbox or a separate folder.
  - Partner apps "must use the same level of E2EE as WhatsApp".
  - European Region only.

  — [Meta Newsroom](https://about.fb.com/news/2025/11/messaging-interoperability-whatsapp-enables-third-party-chats-for-users-in-europe/); [CyberInsider](https://cyberinsider.com/whatsapp-enables-messaging-interoperability-with-birdychat-and-haiket/)
- Only the phone number is shared with third-party apps, and desktop, web and tablet clients are excluded. — [CyberInsider](https://cyberinsider.com/whatsapp-enables-messaging-interoperability-with-birdychat-and-haiket/)
- Meta's earlier roadmap put third-party groups in 2025 and calls in 2027. I found no confirmation that groups shipped. — [UC Today](https://www.uctoday.com/collaboration/metas-whatsapp-is-almost-ready-for-third-party-messaging/)
- BirdyChat opened to everyone in Europe around 5 May 2026, including its 50k waitlist, calling it the first completed WhatsApp interop under the DMA (a company claim). In Nov 2025 it had fewer than 500 Android downloads. — [PPC Land](https://ppc.land/birdychat-opens-to-50k-waitlist-with-whatsapp-interoperability-in-europe/); [Mobile Ecosystem Forum](https://mobileecosystemforum.com/2025/11/17/whatsapps-first-eu-interoperability-partners-named-but-will-birdychat-and-haiket-move-the-needle/); [BirdyChat blog](https://www.birdy.chat/blog/first-to-interoperate-with-whatsapp)

**WhatsApp's own features, which compete with the idea**
- WhatsApp shipped on-device message translation on 23–24 Sep 2025: long-press a message → Translate, working in chats, groups and Channels.
  - Android started with 6 languages (English, Spanish, Hindi, Portuguese, Russian, Arabic) and adds auto-translation of a whole thread.
  - iPhone launched with 19+ languages.
  - WhatsApp says the translation "occur[s] on your device where WhatsApp cannot see them".

  — [GSMArena](https://m.gsmarena.com/whatsapp_message_translations_feature_android_iphone-news-69636.php); [exchange4media](https://www.exchange4media.com/industry-briefing-news/whatsapp-introduces-message-translation-iphone-users-to-get-19-language-support-soon-147781.html)
- A WABetaInfo-sourced report says the iOS version uses Apple's translation APIs. — [Business Standard](https://www.business-standard.com/technology/tech-news/whatsapp-rolls-out-on-device-message-translations-feature-on-ios-report-125100700288_1.html)
- WhatsApp "Writing Help" (Meta AI over Private Processing) launched 27 Aug 2025.
  - It rephrases, proofreads and changes tone (professional, funny, supportive) via a pencil icon in the composer.
  - Private Processing is off by default.
  - It launched in English only, in the US and a few other countries.

  — [TechCrunch](https://techcrunch.com/2025/08/27/whatsapps-new-ai-feature-lets-you-rephrase-and-adjust-the-tone-of-your-messages)

### Inferences
- **Cloud API "tutor contact":** the only ToS-clean WhatsApp product is a business number the learner messages, for example by forwarding a received message or drafting a reply there and copying it back. It never sees the learner's chats with friends. A language tutor whose main function is an LLM is probably an "AI Provider" under Section 4.7 at Meta's discretion. Outside Italy, Brazil and (under the June 2026 order) the EU, it is therefore at risk of being banned. Inside those regions it may face per-message fees.
- **DMA interop:** a learning app could in principle become an EU interoperable messenger. Its users would chat with WhatsApp friends through the learning app's own client and identity, which would let the app show tap-to-translate and writing help on those chats. The costs:
  - building a full E2EE messenger and signing Meta's reference offer;
  - EU-only, 1:1 only, no desktop;
  - the friend must opt in to third-party chats;
  - the learner's existing WhatsApp history and groups do not come across.

  It is a very heavy lift for a learning feature.
- WhatsApp's built-in translation and Writing Help already cover the basic translate-and-rephrase need inside WhatsApp. A third-party app has to win on learning value (word saving, review, explanation) rather than on raw translation.

### Gaps
- Whether Meta actually complied with the EU order of 9 Jun 2026, whether access returned in the EU, and the state of Meta's appeal: I found no reporting after June 2026.
- The country exception list that Section 4.7 links to was not readable.
- I found no reporting on whether a narrow AI tutor or translation bot has been ruled "primary AI functionality".
- Whether DMA third-party group chats shipped in 2026, and whether any partner besides BirdyChat and Haiket went live.
- No public data on ban rates for Baileys, whatsapp-web.js or whatsmeow users.

## Telegram: Bot API vs client API (MTProto/TDLib), Telegram Business chatbots, Mini Apps

### Takeaway
Telegram is the most open major messenger. A full third-party client built on MTProto/TDLib is explicitly allowed: it needs its own api_id, an "Unofficial" name prefix, and must not interfere with core features. Through it, an app sees every chat and controls the composer, so both tap-a-word and writing help are possible. The serious catch is Telegram's API-terms ban on using Telegram data to "deploy" AI/ML. Plain bots cannot see private chats, but **Telegram Business connected bots** receive both sides of the private chats the user chooses, without Premium since 8 May 2026. Mini Apps cannot read chats.

### Cited Findings
**Client API (third-party clients)**
- The Telegram API Terms of Service for third-party clients:
  - each app must "obtain your own api_id";
  - users "must be aware of the fact that your app uses the Telegram API";
  - the app must guard user privacy "with utmost care" and follow the Security Guidelines;
  - basic features must work as in official apps;
  - flagged issues must be fixed within 10 days or API access may be cut;
  - the title may include "Telegram" only if preceded by "Unofficial", and the official logo is forbidden;
  - monetisation (ads or other legitimate means) is allowed if disclosed;
  - official sponsored messages in channels must be supported.

  — [Telegram API Terms](https://core.telegram.org/api/terms)
- Prohibited: "interfere with the basic functionality of Telegram", including "making actions on behalf of the user without the user's knowledge and consent", stopping self-destructing content, faking read status ("ghost mode"), and forcing other users to download your app. Telegram may cut API access and ask app stores to remove a non-compliant app. — [Telegram API Terms](https://core.telegram.org/api/terms)
- **AI/ML clause 1.5:** "you are prohibited from using, accessing or aggregating data obtained from the Telegram platform to train, fine-tune … or otherwise engage in the development, enhancement or deployment of artificial intelligence, machine learning models and similar technologies". The clause cross-references Telegram's separate Content Licensing and AI Scraping terms and lists no exception for user-initiated features. — [Telegram API Terms](https://core.telegram.org/api/terms)

**Plain bots vs Business connected bots**
- Telegram Business (announced 2024): business users "can connect Telegram bots that will process and answer messages on their behalf". The user picks which chats the bot can access, for example excluding contacts or new chats only. — [Telegram blog: Introducing Telegram Business](https://telegram.org/blog/telegram-business)
- grammY's business guide:
  - once connected, "the bot will receive messages from both chat participants", including the owner's own messages;
  - it can send replies that look as if the owner wrote them, with "a small indicator";
  - it can edit its own messages and receives edit and delete updates;
  - it can mark messages read or delete them only with the right permissions;
  - it can message the connecting user via `user_chat_id` even if the user never started the bot;
  - "your bot is NOT able to forward messages from the chat, or copy them elsewhere".

  — [grammY: Telegram Business](https://grammy.dev/advanced/business)
- Bot API changelog:
  - **7.2 (31 Mar 2024)** introduced business connections and `business_message`, edited and deleted updates, and sending on behalf of a business account.
  - **9.0 (11 Apr 2025)** added `BusinessBotRights` (replacing `can_reply`) and methods to read and delete business messages.
  - **10.0 (8 May 2026):** "Allowed Business Bots to manage user accounts without a Telegram Premium subscription", plus guest mode (bots replying in chats they have not joined) and "a method to fetch a user's personal chat messages".
  - The latest version is **10.3, 24 Aug 2026**.

  — [Bot API changelog](https://core.telegram.org/bots/api-changelog); [Bot API](https://core.telegram.org/bots/api)
- SendPulse independently says that from 8 May 2026 Business Bots no longer need Premium. — [SendPulse](https://sendpulse.com/en/knowledge-base/chatbot/telegram/telegram-business)

**Mini Apps**
- Mini Apps receive `initData`: the user, `receiver` for attachment-menu launches in private chats, `chat` / `chat_type` / `chat_instance`, `start_param` and similar fields.
  - The docs describe no API for reading chat messages. "Inline Mini Apps have no access to the chat". Direct-link Mini Apps "can't read messages or send new ones on behalf of the user".
  - Sending goes through `answerWebAppQuery` (an inline message via the bot), `switchInlineQuery` (pre-fills the input field) or `shareMessage` (the user confirms a prepared message).
  - The attachment menu is "currently only available for major advertisers" in production.

  — [Telegram Mini Apps docs](https://core.telegram.org/bots/webapps)
- Bot API 9.6 (3 Apr 2026) added `WebApp.requestChat`, a chat picker that does not read messages. — [Bot API changelog](https://core.telegram.org/bots/api-changelog)

**Telegram's own translation**
- Since the early-2023 update, Premium users can translate whole chats in real time from a Translate bar, and all users can translate single messages (select → Translate). — [9to5Mac](https://9to5mac.com/2023/02/04/telegram-update-translation-annual-premium/); [BGR](https://bgr.com/tech/telegram-announces-first-update-of-the-year-with-entire-chat-translation-profile-photo-maker-feature-and-more/)

### Inferences
- **Telegram client route:** a "learning Telegram client" built on TDLib, named "Unofficial …" with its own api_id, is legal under the terms. It gives full tap-a-word on received messages and a coached composer on both Android and iOS.
  - The biggest risk is clause 1.5. Sending chat text to an LLM for translation or correction could be read as "deployment of AI … using data obtained from the Telegram platform". On-device or rule-based features, or sending only what the user explicitly selects, lower that risk.
  - Ask Telegram for a written ruling before building on this.
  - The user also has to move to a different Telegram app, which is a big adoption cost.
- **Business-bot route:** works inside the official Telegram app.
  - The bot sees the selected private chats and can DM the learner with glosses or corrections in its own bot chat.
  - It cannot add UI inside the friend's chat, so tap-a-word happens in the bot chat or a Mini App, not on the original bubble.
  - It could post corrected replies on the user's behalf, though they would carry the bot indicator.
  - It covers private 1:1 chats only, not groups.
  - Clause 1.5 may also apply, since the Bot API is part of "the Telegram platform".

### Gaps
- Whether Telegram's AI clause 1.5 applies to user-initiated translation or grammar help: I found no Telegram guidance.
- The exact scope of Bot API 10.0's "fetch a user's personal chat messages" method was not read in full (the page was truncated).
- Whether Business bots cover group chats: sources describe private chats only.

## Unified-inbox and bridge products: Beeper, Texts.com, Matrix bridges, Sunbird, Nothing Chats

### Takeaway
Beeper (Automattic) is the surviving multi-network app. In 2025 it moved to on-device connections, using open-source bridges that log in as the user (for WhatsApp, as a linked device). iMessage now works only from a Mac. Texts.com was folded into Beeper. Sunbird / Nothing Chats (2023) and Beeper Mini (2023) were shut down: Apple blocked Beeper Mini, and Sunbird / Nothing Chats had security failures. Beeper offers a local Desktop API/MCP and an experimental "Invoke AI in chats", but I found **no translation or language-learning feature in any of these products**.

### Cited Findings
**Beeper**
- Automattic bought Texts.com in Oct 2023 (reported at $50M; one deal listing gives no price) and Beeper in April 2024 (about $125M). Eric Migicovsky became Automattic's head of messaging, and the teams merged under the Beeper brand. — [TechCrunch](https://techcrunch.com/?p=2688488); [MacStories](https://www.macstories.net/linked/automattic-acquires-messaging-integrator-beeper/); [Mezha](https://mezha.media/en/2024/04/10/automattic-which-owns-wordpress-acquires-universal-chat-app-beeper)
- **July 2025 relaunch:**
  - On-device connections link the device directly to networks like WhatsApp and Signal, instead of relaying through Beeper's cloud.
  - Texts.com was "99% integrated".
  - New paid tiers.
  - Feeds and profile data for Instagram are not supported.

  — [AlternativeTo](https://alternativeto.net/news/2025/7/beeper-relaunches-with-on-device-model-new-features-and-text-com-merged-services); [AOL/CNET](https://www.aol.com/beeper-relaunch-lets-chat-apps-220003071.html)
- Beeper's FAQ:
  - On-Device Connections: "Messages never touch our servers", preserving E2EE "when supported by the network".
  - Beeper Cloud is the "older method", where Beeper's servers bridge to networks with zero-access-encrypted history.
  - "Integrations are open source."
  - Free for up to 5 accounts; Plus from $9.99/month (10 accounts, voice-note transcription, etc.); Plus Plus $49.99/month.
  - Platforms: iOS, Android, macOS, Windows, Linux, ChromeOS.
  - The FAQ says nothing about ToS, bans or translation.

  — [Beeper FAQ](https://beeper.com/faq)
- Beeper bridges run "on your device (when using On-Device Connections) or in our cloud (when using Beeper Cloud)". — [Beeper developer docs: bridges](https://developers.beeper.com/bridges/index.md)
- iMessage in Beeper works only via Beeper on a Mac, as an on-device connection. — [Beeper help: iMessage on macOS](https://beeper.helpjuice.com/en_US/chat-networks/new-imessage-on-macos-getting-started-guide)
- **Beeper Desktop API:**
  - a "fully local" HTTP API with SDKs (TypeScript, Go, Python, PHP) and a built-in MCP server, covering WhatsApp, Instagram, Telegram, Signal, Slack, Discord and others;
  - search, send and draft messages;
  - it "requires Beeper Desktop to be running" and is not reachable from other devices by default;
  - recommended for "personal use only";
  - "Sending too many messages might result in account suspension by the networks."

  — [Beeper Desktop API](https://developers.beeper.com/desktop-api/); [Beeper MCP beta](https://www.beeper.com/mcp)
- Recent Beeper blog posts:
  - Dec 2025: experimental "Invoke AI in Chats" on desktop. GPT models or Apple Intelligence answer inside a chat, and the replies are visible to all members.
  - Feb 2026: X Chat.
  - Jun 2026: a LINE bridge.
  - Sep 2026: Tumblr.
  - Aug 2026: UI localisation (Spanish, French, Japanese, Portuguese).
  - Oct 2025: in-house bridges replaced the bridge bounty.

  The blog mentions no message-translation feature. — [Beeper blog](https://blog.beeper.com/)

**Beeper Mini (iMessage on Android, Dec 2023)**
- Beeper Mini was built on a reverse-engineered iMessage protocol, and Apple cut it off within about two days.
  - Apple said such techniques "pose significant risks to user security and privacy", citing metadata exposure, spam and phishing.
  - Beeper restored service with Apple ID login only. On 14 Dec Beeper said Apple was "deliberately blocking iMessages from being delivered to ~5% of Beeper Mini users", and Apple later shut it down for good.

  — [TechCrunch, 14 Dec 2023](https://techcrunch.com/2023/12/14/apple-again-targets-imessage-on-android-app-beeper-but-company-claims-it-has-a-fix); [Android Authority](https://www.androidauthority.com/beeper-blocked-by-apple-again-3394386); [Macworld](https://www.macworld.com/article/2166857/apple-appears-to-have-quietly-shut-down-beeper-mini-surprising-no-one.html)

**Sunbird and Nothing Chats (Nov 2023)**
- Nothing Chats was built on Sunbird and pulled from Play about a day after launch.
  - Researchers found an unencrypted HTTP request for credentials and JWTs that were signed but not encrypted, with about 630k files reportedly exposed.
  - The promised E2EE did not hold up.
  - Sunbird paused its service "while we investigate security concerns".

  — [9to5Google](https://9to5google.com/2023/11/21/sunbird-shut-down-android-security-concerns/); [Android Authority](https://www.androidauthority.com/sunbird-app-shut-down-3387639); [iMore](https://www.imore.com/iphone/even-sunbird-admits-imessage-on-android-is-a-bad-idea-shuts-down-for-now)

**Matrix bridges**
- mautrix-whatsapp logs in as a WhatsApp linked device through the web API. Ban risk is described above under WhatsApp. — [mautrix docs](https://docs.mau.fi/bridges/go/whatsapp/authentication.html)
- I found no reports linking Beeper users to WhatsApp bans. — [The Star (general WhatsApp suspensions only)](https://www.thestar.com.my/news/nation/2026/10/03/meta-admits-technical-error-caused-wrong-whatsapp-account-suspensions-says-mcmc)

### Inferences
- The proven technical way to "sit on top of" WhatsApp and Messenger is to act as the user's client, either via the linked-device / web protocol or by reverse engineering. That is exactly what WhatsApp's ToS forbids. Beeper has operated this way for years at scale without visible WhatsApp enforcement, but nothing guarantees it will continue.
- iMessage shows the opposite: Apple actively blocks third-party clients.
- A learning app could build on Beeper:
  - as a Desktop API client;
  - by forking the open-source bridges;
  - by being a Beeper integration.

  This would inherit Beeper's network reach and its ToS exposure. The Desktop API is desktop-only, needs Beeper running, and is meant for personal use.
- No unified inbox offers translation or language learning, so that niche looks empty among these products, but the reason it is empty is the legal and technical fragility above.

### Gaps
- No documentation on how Beeper connects to Messenger, Instagram or LINE (official API or reverse engineering).
- Sunbird's status after 2023 and whether Nothing Chats ever returned: not confirmed.
- How the Beeper Desktop API authenticates, and any terms restricting commercial third-party apps beyond "personal use only".
- Whether Meta has ever formally objected to Beeper.

## OS-level routes: Android accessibility, Notification Listener, keyboards (IME), text-selection actions; iOS keyboards, Share extensions, App Intents

### Takeaway
On **Android** there are three ways to get at received messages:
- the **Notification Listener**, which sees message text as it arrives and can reply through the notification's reply action;
- the **AccessibilityService**, which can read the whole chat screen but is heavily policed on Play and blocked by Android 17's Advanced Protection mode;
- **ACTION_PROCESS_TEXT**, an entry in the text-selection menu.

A custom **keyboard (IME)** gives writing help. On **iOS** nothing lets a third-party app read another app's chats or notifications. The only received-message path is the user selecting text and choosing Share (or copy-paste). Writing help works through a **custom keyboard**, which sees only the text field.

### Cited Findings
**Android AccessibilityService (Google Play policy)**
- Only apps "designed to help people with disabilities access their device" may set `isAccessibilityTool`. Assistants, automation tools and monitoring apps do not qualify.
- Other apps may still use the API: "We are not blocking use of this API, but we will require prominent disclosure."
  - The disclosure must appear in-app during normal use, describe the data accessed and its use, require affirmative consent, and be separate from other disclosures.
  - The app must file a Play Console declaration with a video. This has applied since 3 Nov 2021 for apps targeting API 31.
- Use of the API to "autonomously initiate, plan, and execute actions" is "strictly prohibited" for non-tools.
- Deceptive or undeclared use can get the app suspended.

— [Google Play: Use of the AccessibilityService API](https://support.google.com/googleplay/android-developer/answer/10964491?hl=en)
- **Android 16** added the `accessibilityDataSensitive` flag, which apps use to hide sensitive views from non-accessibility-tool services. — [Android Authority teardown](https://www.androidauthority.com/android-advanced-protection-mode-accessibility-apk-teardown-3640742/); [The Hacker News](https://thehackernews.com/2026/03/android-17-blocks-non-accessibility.html)
- **Android 17 (Beta 2, Mar 2026):** when the opt-in Advanced Protection Mode is on, apps not declaring `isAccessibilityTool` cannot use the AccessibilityService. Existing grants are reportedly revoked. Play rejects apps that falsely set the flag, and Play Protect blocks them. I found no confirmation of the final release behaviour. — [The Hacker News](https://thehackernews.com/2026/03/android-17-blocks-non-accessibility.html); [Malaysian Wireless](https://www.malaysianwireless.com/2026/03/android-17-beta2-advanced-protection-mode/)

**Android Notification Listener**
- Android 13 "restricted settings" block **sideloaded** apps from notification access and accessibility by default; the user can override per app. Android 15's CDD extends the list (notification listener, accessibility, device admin, display over other apps, usage access). — [9to5Google](https://9to5google.com/2024/09/12/android-15-sideloaded-apps-restrictions/); [Android Authority](https://androidauthority.com/android-15-restricted-settings-sideloading-3481098)
- On Android 15, untrusted NotificationListenerService apps cannot read unredacted content of notifications that contain a detected OTP. — [Android 15 behaviour changes](https://developer.android.google.cn/about/versions/15/behavior-changes-all?hl=fi); [Android Authority](https://androidauthority.com/android-15-two-factor-authentication-codes-3492585)
- Precedent: AutoResponder for WhatsApp uses notification access to "detect message notifications" from WhatsApp and reply to them. It needs notifications enabled in WhatsApp and, its developer says, processes locally. — [AutoResponder.ai tutorial](https://www.autoresponder.ai/post/how-to-use-the-autoresponder-app-tutorial); [AutoResponder.ai WhatsApp](https://www.autoresponder.ai/whatsapp)

**Android text-selection menu and keyboard**
- `ACTION_PROCESS_TEXT` (Android 6+) lets an app appear in other apps' text-selection menu, the way Google Translate does. The intent carries a read-only flag when the text cannot be edited. — [Android Developers Blog](https://android-developers.googleblog.com/2015/10/in-app-translations-in-android.html?hl=en)
- An Android IME reads and edits the current field through InputConnection (`getTextBeforeCursor`, `getTextAfterCursor`, `getExtractedText`, `commitText`, `deleteSurroundingText`). — [InputConnection reference (mirror)](https://spot.pcc.edu/~mgoodman/developer.android.com/reference/android/view/inputmethod/InputConnection.html); [Android Developers Blog: Creating an input method](https://android-developers.googleblog.com/2009/04/creating-input-method.html?hl=fr)

**iOS custom keyboards**
- A keyboard reads context only through `textDocumentProxy` (`documentContextBeforeInput`) and inserts or deletes at the cursor. It "cannot select text", has no access to the host app's edit menu, and the system replaces it in secure and phone-pad fields.
  - Host apps can reject custom keyboards altogether, e.g. "a banking app".
  - Without `RequestsOpenAccess` it has no network and no shared container. With Full Access it can send keystrokes over the network.
  - Apple's privacy rule: "Do not store received keystroke or voice data except to provide services that are obvious to the user."

  — [Apple: Custom Keyboard (App Extension Programming Guide)](https://developer.apple.com/library/archive/documentation/General/Conceptual/ExtensibilityPG/CustomKeyboard.html)
- App Review 4.4.1: keyboards must provide typing, a next-keyboard key, and "Remain functional without full network access and without requiring full access". They may "Collect user activity only to enhance the functionality of the user's keyboard", and must not launch apps other than Settings. — [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)
- App Review 2.5.2: apps "may not read or write data outside the designated container area". Rule 5.2.2: an app that "uses, accesses … or displays content from a third-party service" must be "specifically permitted to do so under the service's terms of use". — [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)

**iOS translation and the Messages framework**
- Apple's Translation framework: the `translationPresentation` overlay (iOS 17.4+) and the programmatic `TranslationSession` (iOS 18+). Both are on-device, need a language-pack download, and the UI is SwiftUI-only. — [AppCoda](https://direct.appcoda.com/translation-api); [Blake Crosley](https://blakecrosley.com/es/blog/apple-translation-framework-on-device)
- **Announced, adoption unconfirmed:** at WWDC 2025 Apple announced iOS 26 Live Translation in Messages, FaceTime and Phone, and a "Call Translation API". Macworld says it covers "calling, video, and messaging apps"; AppleInsider mentions calling only. I found no messaging app confirmed to have adopted it. — [Macworld](https://www.macworld.com/article/2816543/everyone-will-want-to-try-apples-live-translation-this-fall-heres-where-to-find-it.html); [AppleInsider](https://appleinsider.com/articles/25/06/09/apple-brings-live-translation-to-imessage-phone-calls-and-more)
- iMessage app extensions (Messages framework) see `selectedMessage` (an `MSMessage` the user tapped) and participants only as UUIDs (`localParticipantIdentifier`, `remoteParticipantIdentifiers`). They can `insertText` into the input field or `sendText`. — [Apple: MSConversation](https://developer.apple.com/documentation/messages/msconversation.md)

### Inferences
- **Android, received messages:**
  - The Notification Listener sees new incoming text (from MessagingStyle notifications) while the app is not open, but not history, chats the user has open or muted, or the user's own sent messages.
  - Accessibility sees the chat on screen but needs Play's prominent disclosure and declaration, risks rejection or suspension, fails under Android 17 Advanced Protection, and can be defeated by `accessibilityDataSensitive`.
  - `ACTION_PROCESS_TEXT` is the cleanest tap-a-word route: the user long-presses a word in WhatsApp or Telegram and picks "Learn with …". It reads only what the user selects and needs no special permission, though it depends on the messenger allowing text selection in bubbles.
- **Android, sent messages:** a custom keyboard (IME) is the clean route. It sees and can rewrite the text the user is typing in any messenger. Notification RemoteInput could send replies, but that means sending on the user's behalf.
- **iOS, received messages:** Share sheet / Action extension on selected text, or copy-paste into the app. iOS has no notification-reading API. (Apple's ANCS exposes notifications only to Bluetooth accessories; this is from background knowledge and not verified here.)
- **iOS, sent messages:** a custom keyboard with Full Access can check or rewrite the draft in WhatsApp or Telegram, as Grammarly-style keyboards do. It must still work without Full Access (4.4.1). It cannot see the conversation it is replying in, so its help lacks context unless the user shares the received message first.
- Rule 5.2.2 suggests a pipeline that scrapes WhatsApp content on iOS would face App Review risk on top of WhatsApp ToS risk.

### Gaps
- Whether Google Play requires a declaration or imposes special policy for `BIND_NOTIFICATION_LISTENER_SERVICE`: I found no Play policy page.
- Whether the WhatsApp and Telegram apps let users select a single word inside a message bubble on Android (so `ACTION_PROCESS_TEXT` fires) and on iOS (so the Share / Translate menu appears): not verified.
- The final Android 17 release behaviour for Advanced Protection and accessibility.
- App Intents: I found no evidence that App Intents give a third-party app access to another app's message content. Not researched in depth.

## Signal, iMessage, Facebook Messenger, Viber, LINE: any usable API?

### Takeaway
None gives a third party access to a person's personal chats.
- Messenger, Viber and LINE have business-account bot APIs only. Viber's costs at least €100 a month per bot.
- Signal has no official API; signal-cli is unofficial.
- iMessage has no API. The EU decided it is not a DMA gatekeeper service, and Apple blocks third-party clients. Inside Apple Messages, an iMessage app extension can insert text but cannot read the conversation.

### Cited Findings
- **Messenger:** the Messenger Platform is for business Pages and Instagram Professional accounts answering people who message them first. User IDs from Facebook Login are not meant for the Send/Receive API. — [Messenger Platform overview](https://developers.facebook.com/documentation/business-messaging/messenger-platform/overview); [Messenger Platform FAQ](https://developers.facebook.com/documentation/business-messaging/messenger-platform/faq)
- Integrators confirm personal Messenger accounts cannot be connected. — [Pipedrive FAQ](https://support.pipedrive.com/article/facebook-messenger-integration-faq); [Missive docs](https://missiveapp.com/docs/core-features/connected-accounts/other-channels/social/messenger-business)
- Messenger falls under the DMA too: Meta published a Messenger Reference Offer on 6 Sep 2024. — [Meta Engineering](https://engineering.fb.com/2024/03/06/security/whatsapp-messenger-messaging-interoperability-eu/)
- **Viber:** chatbots created on or after 5 Feb 2024 pay a €100 monthly maintenance fee per bot, plus charges for chatbot-initiated messages. — [Viber Help: Bot commercial model](https://help.viber.com/hc/articles/15247629658525-Bot-commercial-model); [respond.io Viber overview](https://respond.io/help/viber/viber-overview)
- **LINE:** bots use the Messaging API through a LINE Official Account and a Messaging API channel with a webhook. — [LINE Developers guidelines](https://developers.line.biz/en/docs/partner-docs/development-guidelines/); [chat-sdk LINE adapter](https://chat-sdk.dev/adapters/community/line)
- Beeper added a LINE bridge in June 2026. — [Beeper blog](https://blog.beeper.com/)
- **Signal:** there is no supported official API. signal-cli is "an unofficial commandline and dbus interface" for libsignal-service-java and must be kept updated because official clients expire after three months. Community commenters say Signal can lock out unofficial clients, but this is unverified. — [signal-cli via codekk](https://p.codekk.com/detail/60dbf890982bbb72602819bc); [factually.co](https://factually.co/fact-checks/electronics-tech/api-to-place-signal-call-from-computer-eb52ff)
- **iMessage:**
  - On 13 Feb 2024 the European Commission decided iMessage is not a gatekeeper core platform service, so it carries no DMA interop duty. — [MobileSyrup](https://mobilesyrup.com/2024/02/13/apple-imessage-escapes-dma-regulation-eu/); [Neowin](https://www.neowin.net/news/apple-and-microsoft-get-a-break-from-eu-as-imessage-and-bing-wont-be-considered-gatekeepers/)
  - Apple blocked Beeper Mini, as described above.
  - The Messages-framework extension sees only the selected `MSMessage` and participant UUIDs, and can insert or send text. — [Apple: MSConversation](https://developer.apple.com/documentation/messages/msconversation.md)

### Inferences
- **iMessage:** an iMessage app extension could offer writing help inside Apple Messages: the user opens the app drawer, composes with help, and `insertText` puts it in the input field. It cannot read the other person's message, so received messages still need copy or share.
- **Messenger, Viber, LINE:** the only official option is a "tutor bot" account the learner messages directly, the same shape as the WhatsApp Cloud API route.

### Gaps
- Signal's official stance on third-party clients: I did not find a primary statement.
- Apple Messages for Business was not researched (it is for businesses, not personal chats).
- LINE and Viber rules on AI chatbots: not researched.

## Overall: which routes give tap-a-word on RECEIVED messages and help on SENT ones, on Android and iOS, without breaking terms?

### Takeaway
No single ToS-clean route reads received messages *inside* WhatsApp on both platforms. The clean combination is OS-level and user-initiated:
- **Android:** a selection action (`ACTION_PROCESS_TEXT`) or the Notification Listener for received text, plus a custom keyboard for sent text.
- **iOS:** the Share sheet or copy-paste for received text, plus a custom keyboard for sent text.

Telegram is the one network where a deep integration is allowed (your own client, or a Business bot), but its AI clause is a real legal question. Everything that "integrates" with WhatsApp the way Beeper does breaks WhatsApp's Terms.

### Cited Findings
Route by route (citations in the sections above):

| Route | Received: tap-a-word | Sent: writing help | Android | iOS | Terms |
|---|---|---|---|---|---|
| WhatsApp Cloud API tutor number | Only messages the user forwards to the bot | Yes, in the bot chat; the user copies the result back | Yes | Yes | Allowed for business use. An AI-primary tutor is at Meta's discretion under Section 4.7, with regional carve-outs (Italy, Brazil with a fee, EU interim order) — [Meta Terms](https://www.facebook.com/legal/Meta-Terms-for-WhatsApp-Business-Platform) |
| WhatsApp linked device (Baileys, whatsmeow, Beeper-style) | Full | Full (it is the client) | Yes | Yes | Breaks WhatsApp ToS on automated/unauthorised access, derivative works and "substantially the same" software; ban risk — [WhatsApp ToS](https://www.whatsapp.com/legal/terms-of-service-eea) |
| WhatsApp DMA interop (become a messenger) | Full, in your own app | Full | Yes | Yes | Allowed in the EU only, 1:1 only, full E2EE messenger required — [Meta Newsroom](https://about.fb.com/news/2025/11/messaging-interoperability-whatsapp-enables-third-party-chats-for-users-in-europe/) |
| Telegram third-party client (TDLib) | Full | Full | Yes | Yes | Allowed, but clause 1.5 restricts using Telegram data to "deploy" AI/ML — [Telegram API Terms](https://core.telegram.org/api/terms) |
| Telegram Business connected bot | Both sides of the private chats the user picks (glosses delivered in the bot chat) | It can reply as the user (marked); no composer access | Yes | Yes | Allowed; no Premium needed since 8 May 2026; clause 1.5 question — [Bot API changelog](https://core.telegram.org/bots/api-changelog) |
| Android Notification Listener | New incoming text only | Reply via notification action | Yes | n/a | Platform-allowed; sideloaded apps restricted — [9to5Google](https://9to5google.com/2024/09/12/android-15-sideloaded-apps-restrictions/) |
| Android AccessibilityService | Full screen | Can read and type | Yes | n/a | Play disclosure and declaration required, autonomous use banned, blocked under Android 17 Advanced Protection — [Play policy](https://support.google.com/googleplay/android-developer/answer/10964491?hl=en) |
| Android ACTION_PROCESS_TEXT | The word or phrase the user selects | — | Yes | n/a | Standard platform feature — [Android Developers Blog](https://android-developers.googleblog.com/2015/10/in-app-translations-in-android.html?hl=en) |
| Custom keyboard (Android IME / iOS extension) | — (cannot see the chat) | Yes: reads and rewrites the draft | Yes | Yes | Allowed. On iOS it must work without Full Access, and apps may reject custom keyboards — [Apple keyboard guide](https://developer.apple.com/library/archive/documentation/General/Conceptual/ExtensibilityPG/CustomKeyboard.html); [App Review 4.4.1](https://developer.apple.com/app-store/review/guidelines/) |
| iOS Share sheet / Action extension, or copy-paste | The text the user selects or copies | — | Yes | Yes | Allowed |
| Beeper Desktop API | Full (desktop only) | Full | Desktop only | Desktop only | Beeper says "personal use only" and inherits each network's ToS — [Beeper Desktop API](https://developers.beeper.com/desktop-api/) |

### Inferences
- **Recommended clean stack:**
  - **Android:** an `ACTION_PROCESS_TEXT` entry ("tap/select a word → explain and save"), plus an optional Notification Listener (to queue received messages for study), plus a custom IME that checks or corrects the draft.
  - **iOS:** a Share or Action extension for selected text, plus a custom keyboard extension for drafting help.

  The received-message experience on iOS is weaker: the user has to select and share, and the keyboard cannot see what it is replying to. A keyboard "paste the message you're answering" field could bridge that gap.
- **Telegram:** the only network where deep, in-conversation integration is contractually allowed, through your own client or a Business bot. Get a reading or ruling on clause 1.5 before building.
- **WhatsApp:** treat any "integration" as either an EU-only DMA messenger (expensive) or a ToS violation (fragile). WhatsApp's native translation (Sept 2025) and Writing Help (Aug 2025) also shrink the gap a third-party app could fill.

### Gaps
- No primary-source statement from Meta, Telegram or Apple on whether a language-learning use case is acceptable under any of these routes.
- Not verified: whether WhatsApp and Telegram bubbles allow single-word selection on each OS, which the selection and share routes depend on.
