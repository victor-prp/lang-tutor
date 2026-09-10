// Placeholder recordings derived from the authored content in `db/content.ts`.
// These are NOT provider recordings: no model produced them. Each entry is
// single-sense and carries no `example`, because that is all the authored source
// (lemma, part_of_speech, translation) contained.
//
// Run `npm run content:generate` with a real GEMINI_API_KEY to replace these
// with genuine recordings, and read the diff before committing. Only once real
// recordings are in place does DO NOT EDIT BY HAND apply.
import type { LlmTranslation } from '@lang-tutor/core/api';

export const recorded: Record<string, LlmTranslation> = {
  "window": {
    "kind": "word",
    "entries": [
      {
        "lemma": "window",
        "senses": [
          {
            "translation": "חלון",
            "part_of_speech": "noun",
            "sense_code": "window"
          }
        ]
      }
    ]
  },
  "book": {
    "kind": "word",
    "entries": [
      {
        "lemma": "book",
        "senses": [
          {
            "translation": "ספר",
            "part_of_speech": "noun",
            "sense_code": "book"
          }
        ]
      }
    ]
  },
  "water": {
    "kind": "word",
    "entries": [
      {
        "lemma": "water",
        "senses": [
          {
            "translation": "מים",
            "part_of_speech": "noun",
            "sense_code": "water"
          }
        ]
      }
    ]
  },
  "friend": {
    "kind": "word",
    "entries": [
      {
        "lemma": "friend",
        "senses": [
          {
            "translation": "חבר",
            "part_of_speech": "noun",
            "sense_code": "friend"
          }
        ]
      }
    ]
  },
  "difficult": {
    "kind": "word",
    "entries": [
      {
        "lemma": "difficult",
        "senses": [
          {
            "translation": "קשה",
            "part_of_speech": "adjective",
            "sense_code": "difficult"
          }
        ]
      }
    ]
  },
  "to remember": {
    "kind": "word",
    "entries": [
      {
        "lemma": "remember",
        "senses": [
          {
            "translation": "לזכור",
            "part_of_speech": "verb",
            "sense_code": "remember"
          }
        ]
      }
    ]
  },
  "excuse me": {
    "kind": "phrase",
    "entries": [
      {
        "lemma": "excuse me",
        "senses": [
          {
            "translation": "סליחה",
            "part_of_speech": "phrase",
            "sense_code": "excuse_me"
          }
        ]
      }
    ]
  },
  "good morning": {
    "kind": "phrase",
    "entries": [
      {
        "lemma": "good morning",
        "senses": [
          {
            "translation": "בוקר טוב",
            "part_of_speech": "phrase",
            "sense_code": "good_morning"
          }
        ]
      }
    ]
  },
  "thank you very much": {
    "kind": "phrase",
    "entries": [
      {
        "lemma": "thank you very much",
        "senses": [
          {
            "translation": "תודה רבה",
            "part_of_speech": "phrase",
            "sense_code": "thank_you_very_much"
          }
        ]
      }
    ]
  },
  "How do you do?": {
    "kind": "phrase",
    "entries": [
      {
        "lemma": "How do you do?",
        "senses": [
          {
            "translation": "מה נשמע?",
            "part_of_speech": "phrase",
            "sense_code": "how_do_you_do"
          }
        ]
      }
    ]
  },
  "see you later": {
    "kind": "phrase",
    "entries": [
      {
        "lemma": "see you later",
        "senses": [
          {
            "translation": "נתראה אחר כך",
            "part_of_speech": "phrase",
            "sense_code": "see_you_later"
          }
        ]
      }
    ]
  },
  "I don't understand": {
    "kind": "phrase",
    "entries": [
      {
        "lemma": "I don't understand",
        "senses": [
          {
            "translation": "אני לא מבין",
            "part_of_speech": "phrase",
            "sense_code": "i_don_t_understand"
          }
        ]
      }
    ]
  },
  "What is your name?": {
    "kind": "phrase",
    "entries": [
      {
        "lemma": "What is your name?",
        "senses": [
          {
            "translation": "איך קוראים לך?",
            "part_of_speech": "phrase",
            "sense_code": "what_is_your_name"
          }
        ]
      }
    ]
  },
  "Have a nice day!": {
    "kind": "phrase",
    "entries": [
      {
        "lemma": "Have a nice day!",
        "senses": [
          {
            "translation": "שיהיה לך יום נעים!",
            "part_of_speech": "phrase",
            "sense_code": "have_a_nice_day"
          }
        ]
      }
    ]
  },
  "Where is the station?": {
    "kind": "phrase",
    "entries": [
      {
        "lemma": "Where is the station?",
        "senses": [
          {
            "translation": "איפה התחנה?",
            "part_of_speech": "phrase",
            "sense_code": "where_is_the_station"
          }
        ]
      }
    ]
  },
  "Nice to meet you": {
    "kind": "phrase",
    "entries": [
      {
        "lemma": "Nice to meet you",
        "senses": [
          {
            "translation": "נעים להכיר",
            "part_of_speech": "phrase",
            "sense_code": "nice_to_meet_you"
          }
        ]
      }
    ]
  }
};
