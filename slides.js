export const SLIDES = [
  {
    id: 0,
    title: 'What Are Antibiotics?',
    bullets: [
      'Medicines that kill bacteria or stop them from growing',
      'Treat bacterial infections — they do nothing against viruses like the flu or a cold',
      'Work by targeting things bacterial cells need that human cells don\'t, like cell walls',
      'One of the most important medical advances of the 20th century',
    ],
    notes: 'High-level definition. Use for "what is an antibiotic" or "how do they work" questions.',
  },
  {
    id: 1,
    title: 'The Discovery of Penicillin',
    bullets: [
      'Alexander Fleming discovered it by accident in 1928 at St. Mary\'s Hospital, London',
      'A mold called Penicillium had contaminated a petri dish and killed the bacteria around it',
      'Howard Florey and Ernst Chain later purified it into a usable drug in the early 1940s',
      'Mass-produced in time to treat wounded soldiers in World War II',
    ],
    notes: 'The Fleming/penicillin origin story. Use for "who discovered antibiotics" or "history of penicillin" questions.',
  },
  {
    id: 2,
    title: 'Types of Antibiotics',
    bullets: [
      'Penicillins (e.g. amoxicillin) — disrupt bacterial cell wall formation',
      'Macrolides (e.g. azithromycin) — block bacteria from making proteins',
      'Tetracyclines and fluoroquinolones — broad-spectrum, used for many infection types',
      'Narrow-spectrum antibiotics target specific bacteria; broad-spectrum target many kinds',
    ],
    notes: 'Classes and how they differ. Use for "what kinds of antibiotics are there" questions.',
  },
  {
    id: 3,
    title: 'Antibiotics in Modern Medicine',
    bullets: [
      'Used to treat infections from strep throat to pneumonia to sepsis',
      'Essential for making surgery, chemotherapy, and organ transplants safe',
      'Prescribed as pills, IV drips, creams, or drops depending on the infection',
      'Doctors choose a specific antibiotic based on the bacteria and infection site',
    ],
    notes: 'Present-day clinical use. Use for "how are antibiotics used today" or "why do we still need them" questions.',
  },
  {
    id: 4,
    title: 'Antibiotic Resistance',
    bullets: [
      'Bacteria evolve to survive drugs that used to kill them',
      'Driven by overuse and misuse — unnecessary prescriptions, not finishing a course',
      'Creates "superbugs" like MRSA that are much harder to treat',
      'The WHO calls it one of the biggest threats to global health today',
    ],
    notes: 'The resistance crisis. Use for "why don\'t antibiotics work anymore" or "what is a superbug" questions.',
  },
  {
    id: 5,
    title: 'References',
    bullets: [
      'World Health Organization — "Antibiotic resistance" fact sheet (who.int)',
      'CDC — "About Antibiotic Resistance" (cdc.gov/antibiotic-use)',
      'Fleming, A. (1929). "On the Antibacterial Action of Cultures of a Penicillium." British Journal of Experimental Pathology',
      'American Chemical Society — "Discovery and Development of Penicillin" (National Historic Chemical Landmark)',
    ],
    notes: 'Sources for the material in this deck. Use when asked "where does this information come from" or "what are your sources."',
  },
];

export const CHANGE_SLIDE_TOOL = {
  type: 'function',
  function: {
    name: 'change_slide',
    description:
      'Switch the presentation to a specific slide. Call this whenever the user asks a question best answered by a different slide, asks to go forward/back, or asks to jump to a topic by name.',
    parameters: {
      type: 'object',
      properties: {
        index: {
          type: 'integer',
          minimum: 0,
          maximum: SLIDES.length - 1,
          description: 'Zero-based index of the slide to show.',
        },
        reason: {
          type: 'string',
          description: 'Very brief reason for switching slides (for logging only).',
        },
      },
      required: ['index'],
    },
  },
};

export function buildInstructions(slides) {
  const outline = slides
    .map(
      (s, i) =>
        `Slide ${i} — "${s.title}":\n  - ${s.bullets.join('\n  - ')}\n  (Use this slide when: ${s.notes})`
    )
    .join('\n\n');

  return `You are a friendly, knowledgeable AI presenter giving a live voice talk on "Antibiotics: From Discovery to Resistance" using a ${slides.length}-slide deck.

SLIDE DECK CONTENTS:
${outline}

BEHAVIOR RULES:
1. Start by briefly greeting the listener and presenting slide 0 in your own words (don't just read bullets verbatim — explain naturally in 2-4 sentences).
2. The listener can ask questions or interrupt you at any time. If they start talking while you're speaking, stop immediately and listen.
3. Whenever the user's question relates most closely to a different slide than the one currently shown, call the change_slide function with that slide's index BEFORE or while you answer, so the visual stays in sync with what you're saying.
4. If the user says "next slide", "go back", "previous", or names a topic, call change_slide accordingly.
5. Keep spoken answers conversational and concise (a few sentences), like a real presenter fielding a question, not a wall of text.
6. If a question is unrelated to the deck, answer briefly and offer to return to the presentation.
7. Never call change_slide with an index outside 0-${slides.length - 1}.
8. The last slide (${slides.length - 1}) lists sources — jump there if asked where the information comes from, but don't read it aloud verbatim; just mention it lists the sources.`;
}
