// Builds bots/words/{en,ru,it}.txt (spec D15, ruling 25) from hermitdave/FrequencyWords' 2018
// OpenSubtitles lists. Run by hand when the rule changes; the sources are not committed:
//
//   for l in en ru it; do curl -sSfLO https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/$l/${l}_50k.txt; done
//   node bots/words/build.mjs <directory holding the three files> bots/words
//
// The rule: skip the 100 most frequent words, keep alphabetic words of three letters or more,
// drop contraction fragments, number words and a short stoplist of function words, and keep the
// next 1,000, most frequent first. Each word a bot saves is a dictionary lookup against
// production, so a fragment ("didn") or a bare article makes a junk entry there.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const KEEP = 1000;
const SKIP_TOP = 100;
const MIN_LETTERS = 3;

const LETTERS = { en: /^[a-z]+$/u, ru: /^[а-яё]+$/u, it: /^[a-zàèéìòù]+$/u };

const words = (text) => text.trim().split(/\s+/u);

// What is left of "didn't", "we'll", "gonna" once the apostrophe goes. Italian elisions
// ("dell'", "com'è") are caught by the consonant rule below instead.
const FRAGMENTS = {
  en: words(`didn isn don doesn wasn weren aren hasn haven hadn couldn wouldn shouldn mustn needn
    mightn ain won ll ve re gonna wanna gotta dunno lemme gimme outta kinda sorta ya yeah yep nope
    cannot okay`),
  ru: [],
  it: [],
};

// Cardinals and the large units; ordinals are adjectives and stay.
const NUMBERS = {
  en: words(`zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen
    fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty
    ninety hundred hundreds thousand thousands million millions billion billions`),
  ru: words(`ноль нуля один одна одно одни одного одной одному одним одну два две двух двум двумя
    три трёх трех трём трем тремя четыре четырёх четырех пять пяти шесть шести семь семи восемь
    восьми девять девяти десять десяти одиннадцать двенадцать тринадцать четырнадцать пятнадцать
    шестнадцать семнадцать восемнадцать девятнадцать двадцать двадцати тридцать тридцати сорок
    сорока пятьдесят шестьдесят семьдесят восемьдесят девяносто сто ста двести триста четыреста
    пятьсот шестьсот семьсот восемьсот девятьсот тысяча тысячи тысяч тысячу миллион миллиона
    миллионов миллиард миллиарда миллиардов`),
  it: words(`zero uno una due tre quattro cinque sei sette otto nove dieci undici dodici tredici
    quattordici quindici sedici diciassette diciotto diciannove venti trenta quaranta cinquanta
    sessanta settanta ottanta novanta cento duecento trecento mille mila milione milioni miliardo
    miliardi`),
};

// Closed-class words: articles, pronouns, determiners, prepositions, conjunctions, auxiliaries
// and modals, and particles. Short on purpose; content words stay, adverbs included.
const FUNCTION_WORDS = {
  en: words(`the and but nor for yet you your yours yourself yourselves him his himself she her hers
    herself its itself our ours ourselves they them their theirs themselves mine myself this that
    these those which who whom whose what where when why how there here than then from into onto
    upon about above below over under after before between through during without within against
    among around behind beyond toward towards across since until till off out not are was were
    been being have has had having does did doing will would shall should can could may might
    must also just very each every either neither both all any some such`),
  ru: words(`меня мне мной тебя тебе тобой него нему ним нём нем она её ее ней неё нее ею оно они
    них ими ними нас нам нами вас вам вами себя себе собой мой моя моё мое мои моего моей мою моих
    моим моими моему твой твоя твоё твое твои твоего твоей твою твоих твоим твоему наш наша наше
    наши нашего нашей нашу наших нашим ваш ваша ваше ваши вашего вашей вашу ваших вашим свой своя
    своё свое свои своего своей свою своих своим своему этот эта это эти этого этой этим этих эту
    этому этом тот того той тем тех тому том который которая которое которые которого которой
    которую которых которым кто что чего чем чём кого кому где когда как так тоже также ведь вот
    уже ещё еще или либо если чтобы потому хотя тогда для без через перед между под над при про
    был была было были буду будет будешь будем будете будут быть есть нет`),
  it: words(`il lo la gli le un una del dello della dei degli delle al allo alla ai agli alle dal
    dallo dalla dai dagli dalle nel nello nella nei negli nelle sul sullo sulla sui sugli sulle con
    per tra fra che chi cui non lui lei noi voi loro mio mia miei mie tuo tua tuoi tue suo sua suoi
    sue nostro nostra nostri nostre vostro vostra vostri vostre questo questa questi queste quello
    quella quelli quelle quel quei quegli sono sei siamo siete ero era eri eravamo erano sarà sarò
    sarai saremo sarebbe sarei fosse fossi stato stata stati state hai abbiamo avete hanno avevo
    aveva avevi avevamo avevano avuto abbia abbiamo come dove quando perché anche più così quindi
    poi mentre però ancora già`),
};

// Not function words, but junk for a learner's list all the same.
const PROFANITY = {
  en: words('shit fuck fucking fucked bitch damn ass asshole crap bastard'),
  ru: words('черт чёрт блин блядь хрен'),
  it: words('cazzo merda cazzi stronzo fottuto cavolo'),
};

const ACCENTED = { a: 'à', e: 'è', i: 'ì', o: 'ò', u: 'ù' };

/** Why a word is dropped, or null when it is kept. */
export function dropReason(language, word, source) {
  if (!LETTERS[language].test(word) || [...word].length < MIN_LETTERS) return 'shape';
  if (FRAGMENTS[language].includes(word)) return 'fragment';
  if (NUMBERS[language].includes(word)) return 'number';
  if (FUNCTION_WORDS[language].includes(word)) return 'function';
  if (PROFANITY[language].includes(word)) return 'profanity';
  if (language === 'it') {
    // Italian words end in a vowel. One that does not is an elision ("dell'", "com'è"), a
    // truncation ("signor") or a loanword ("okay", "film"), none of them worth a lookup.
    if (!/[aeiouàèéìòù]$/u.test(word)) return 'fragment';
    // "gia", "puo", "perche": the subtitle's accent lost, beside the word that has it.
    const last = word.slice(-1);
    if (ACCENTED[last] && source.has(word.slice(0, -1) + ACCENTED[last])) return 'fragment';
    if (last === 'e' && source.has(word.slice(0, -1) + 'é')) return 'fragment';
  }
  return null;
}

function build(language, text) {
  const ranked = text
    .split('\n')
    .map((line) => line.split(' ')[0])
    .filter(Boolean);
  const source = new Set(ranked);
  const counts = {};
  const kept = [];
  for (const word of ranked.slice(SKIP_TOP)) {
    const reason = dropReason(language, word, source);
    if (reason) {
      counts[reason] = (counts[reason] ?? 0) + 1;
      continue;
    }
    kept.push(word);
    if (kept.length === KEEP) break;
  }
  return { kept, counts };
}

const HEADER = (language) =>
  [
    `# Source: https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/${language}/${language}_50k.txt`,
    '# Licence: CC-BY-SA-4.0 (hermitdave/FrequencyWords, OpenSubtitles 2018)',
    `# The ${KEEP.toLocaleString('en')} most frequent alphabetic words of three letters or more after the top ${SKIP_TOP}, most frequent first,`,
    '# without contraction fragments, number words, function words or profanity (bots/words/build.mjs).',
  ].join('\n');

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const [from, to] = process.argv.slice(2);
  if (!from || !to) {
    console.error('usage: node bots/words/build.mjs <source directory> <output directory>');
    process.exit(1);
  }
  for (const language of ['en', 'ru', 'it']) {
    const { kept, counts } = build(language, readFileSync(join(from, `${language}_50k.txt`), 'utf8'));
    writeFileSync(join(to, `${language}.txt`), `${HEADER(language)}\n${kept.join('\n')}\n`);
    console.log(`${language}: ${kept.length} kept; dropped ${JSON.stringify(counts)}`);
  }
}
