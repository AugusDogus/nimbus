/**
 * A deterministic, drive-shaped tree of names for the search benchmark: photo
 * libraries by year and event, documents, finance folders by year, code
 * repositories, music, videos, backups and some non-Latin names. Paths are
 * generated, never written to disk, so 10 million entries cost only memory.
 *
 * A small set of planted files backs the labeled relevance cases; they are
 * added at every size, so the same questions are asked of 100k and 10M trees.
 */

const hash = (value: number) => {
  let x = Math.imul(value ^ (value >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  return (x ^ (x >>> 16)) >>> 0;
};

/** The `salt`-th deterministic choice for entry `i`. */
const choose = <T>(items: readonly T[], i: number, salt: number): T => {
  const item = items[hash(i * 31 + salt) % items.length];
  if (item === undefined) throw new Error("choose() needs a non-empty list");
  return item;
};
const number = (i: number, salt: number, below: number) =>
  hash(i * 31 + salt) % below;
const pad = (value: number, width: number) =>
  String(value).padStart(width, "0");

const words = [
  "annual",
  "budget",
  "report",
  "invoice",
  "project",
  "meeting",
  "notes",
  "design",
  "draft",
  "final",
  "archive",
  "summary",
  "proposal",
  "contract",
  "receipt",
  "statement",
  "presentation",
  "schedule",
  "agenda",
  "review",
  "plan",
  "checklist",
  "minutes",
  "forecast",
  "roadmap",
  "brief",
  "letter",
  "resume",
  "policy",
  "handbook",
];
const events = [
  "Summer beach trip",
  "Christmas",
  "Birthday party",
  "Wedding",
  "Hiking",
  "Graduation",
  "Road trip",
  "Thanksgiving",
  "Ski weekend",
  "Garden",
];
const repos = [
  "apollo",
  "nimbus-web",
  "dotfiles",
  "photo-sorter",
  "budget-app",
  "game-engine",
  "blog",
  "home-automation",
];
const codeFolders = ["src", "docs", "tests", "assets", "scripts", "config"];
const codeSub = ["components", "lib", "utils", "hooks", "routes", "server"];
const codeWords = [
  "Button",
  "Search",
  "Index",
  "Worker",
  "Client",
  "Server",
  "Config",
  "Router",
  "Thumbnail",
  "Preview",
  "Upload",
  "Download",
  "Storage",
  "Session",
  "Schema",
  "Migration",
  "Auth",
  "Permissions",
  "Table",
  "Dialog",
];
const artists = [
  "The Beatles",
  "Miles Davis",
  "Radiohead",
  "Björk",
  "Daft Punk",
  "Nina Simone",
  "坂本龍一",
  "Fleetwood Mac",
];
const titles = [
  "Intro",
  "Blue in Green",
  "Something",
  "Around the World",
  "Feeling Good",
  "Dreams",
  "Everything In Its Right Place",
  "Hyperballad",
];
const shows = ["Planet Earth", "The Office", "Cosmos", "Chef's Table"];
const stores = ["costco", "ikea", "amazon", "target", "rei", "apple"];
const banks = ["chase", "ally", "schwab", "amex"];
const machines = ["laptop", "desktop", "nas", "phone"];
const docAreas = ["Work", "Personal", "School", "Household"];
const docTopics = [
  "Clients",
  "Hiring",
  "Taxes",
  "Insurance",
  "Car",
  "Health",
  "Travel",
  "Recipes",
  "Courses",
  "Team",
];
const docExtensions = ["docx", "pdf", "xlsx", "txt", "md", "pptx"];
const codeExtensions = ["ts", "tsx", "js", "json", "md", "css"];

/** One file path for generated entry `i`. */
export function pathAt(i: number): string {
  const id = i.toString(36);
  const year = 2015 + number(i, 1, 12);
  const month = 1 + number(i, 2, 12);
  const day = 1 + number(i, 3, 28);
  const date = `${year}${pad(month, 2)}${pad(day, 2)}`;
  const kind = number(i, 0, 100);
  if (kind < 30) {
    const folder =
      number(i, 4, 3) === 0
        ? `${year}-${pad(month, 2)} ${choose(events, i, 5)}`
        : pad(month, 2);
    const name =
      number(i, 6, 4) === 0
        ? `DSC_${pad(number(i, 7, 10000), 4)}_${id}.JPG`
        : `IMG_${date}_${pad(number(i, 8, 240000), 6)}.${number(i, 9, 5) === 0 ? "HEIC" : "jpg"}`;
    return `Photos/${year}/${folder}/${name}`;
  }
  if (kind < 50) {
    const a = choose(words, i, 10);
    const b = choose(words, i, 11);
    const ext = choose(docExtensions, i, 12);
    const area = choose(docAreas, i, 13);
    const topic = choose(docTopics, i, 14);
    const name = [
      `${a} ${b} ${year}.${ext}`,
      `${a}-${b}-v${number(i, 15, 9)}-${id}.${ext}`,
      `Meeting notes ${year}-${pad(month, 2)}-${pad(day, 2)}.md`,
      `${a[0]?.toUpperCase()}${a.slice(1)} ${b} (${id}).${ext}`,
    ][number(i, 16, 4)];
    return `Documents/${area}/${topic}/${name}`;
  }
  if (kind < 58) {
    const sub = choose(["Invoices", "Receipts", "Statements", "Taxes"], i, 17);
    const name =
      sub === "Invoices"
        ? `invoice-${pad(number(i, 18, 10000), 4)}-${id}.pdf`
        : sub === "Receipts"
          ? `receipt-${choose(stores, i, 19)}-${date}.pdf`
          : sub === "Statements"
            ? `statement-${choose(banks, i, 20)}-${year}-${pad(month, 2)}.pdf`
            : `${choose(["1099", "W2", "return", "estimate"], i, 21)}-${id}.pdf`;
    return `Finance/${year}/${sub}/${name}`;
  }
  if (kind < 83) {
    const repo = choose(repos, i, 22);
    const top = choose(codeFolders, i, 23);
    const sub = choose(codeSub, i, 24);
    const a = choose(codeWords, i, 25);
    const b = choose(codeWords, i, 26);
    const ext = choose(codeExtensions, i, 27);
    const name = [
      `${a}${b}.${ext}`,
      `${a.toLowerCase()}-${b.toLowerCase()}-${id}.${ext}`,
      `use${a}${b}.ts`,
      `${a}${b}.test.ts`,
    ][number(i, 28, 4)];
    return `Code/${repo}/${top}/${sub}/${pad(number(i, 29, 40), 2)}/${name}`;
  }
  if (kind < 90) {
    const artist = choose(artists, i, 30);
    return `Music/${artist}/Album ${number(i, 31, 30)}/${pad(1 + number(i, 32, 20), 2)} ${choose(titles, i, 33)} ${id}.${number(i, 34, 3) === 0 ? "flac" : "mp3"}`;
  }
  if (kind < 94)
    return number(i, 35, 2) === 0
      ? `Videos/${year}/VID_${date}_${id}.mp4`
      : `Videos/Shows/${choose(shows, i, 36)}/${choose(shows, i, 36)} S${pad(1 + number(i, 37, 9), 2)}E${pad(1 + number(i, 38, 24), 2)} ${id}.mkv`;
  if (kind < 98)
    return `Backups/${choose(machines, i, 39)}/${year}-${pad(month, 2)}/${(hash(i + 7) >>> 0).toString(16)}${id}.${number(i, 40, 2) === 0 ? "bin" : "tar.gz"}`;
  return number(i, 41, 2) === 0
    ? `Shared/家族/写真_家族_${id}.jpg`
    : `Shared/Résumés/Résumé café ${id}.pdf`;
}

/** Files planted for the relevance cases, with distractors around them. */
export const plantedFiles = [
  "Home/Renovation/kitchen-renovation-quote.pdf",
  "Home/Renovation/kitchen photos/before.jpg",
  "Home/Renovation/bathroom-renovation-quote.pdf",
  "Documents/Work/Reports/annual 2026 report.pdf",
  "Documents/Work/Reports/annual-report-2025.pdf",
  "Finance/Taxes/2023/W2 - employer.pdf",
  "Finance/Taxes/2023/1099-INT bank.pdf",
  "Finance/Taxes/2022/W2 - employer.pdf",
  "Clients/Acme/invoice-acme-0042.pdf",
  "Clients/Acme/contract-acme-signed.pdf",
  "Clients/Globex/invoice-globex-0007.pdf",
  "Documents/Household/Recipes/lasagna-recipe.md",
  "Documents/Household/Recipes/pancakes.md",
  "Projects/robot/robot-arm.blend",
  "Projects/robot/robot-arm-notes.md",
  "Projects/website/notes.txt",
  "Documents/Work/Team/meeting-notes.txt",
  "Finance/budget-2026.xlsx",
] as const;

/** Paths of the entries the relevance user has opened, most recent first. */
export const plantedHistory = [
  "Documents/Work/Team/meeting-notes.txt",
  "Finance/budget-2026.xlsx",
] as const;

export type RelevanceCase = {
  /** What a person is trying to do. */
  task: string;
  query: string;
  /** The result that answers the task; its 1-based rank is scored. */
  expected: string;
  /** Whether the case uses the user's open history. */
  history: boolean;
};

export const relevanceCases: readonly RelevanceCase[] = [
  {
    task: "partial name",
    query: "kitchen reno",
    expected: "Home/Renovation/kitchen-renovation-quote.pdf",
    history: false,
  },
  {
    task: "partial name, one word",
    query: "lasagna",
    expected: "Documents/Household/Recipes/lasagna-recipe.md",
    history: false,
  },
  {
    task: "two words out of order",
    query: "quote bathroom",
    expected: "Home/Renovation/bathroom-renovation-quote.pdf",
    history: false,
  },
  {
    task: "two words with one in between",
    query: "kitchen quote",
    expected: "Home/Renovation/kitchen-renovation-quote.pdf",
    history: false,
  },
  {
    task: "folder plus name",
    query: "2023 employer",
    expected: "Finance/Taxes/2023/W2 - employer.pdf",
    history: false,
  },
  {
    task: "folder plus name",
    query: "acme invoice",
    expected: "Clients/Acme/invoice-acme-0042.pdf",
    history: false,
  },
  {
    task: "path-qualified",
    query: "robot/notes",
    expected: "Projects/robot/robot-arm-notes.md",
    history: false,
  },
  {
    task: "typo",
    query: "lasagan",
    expected: "Documents/Household/Recipes/lasagna-recipe.md",
    history: false,
  },
  {
    task: "typo with a second word",
    query: "invioce acme",
    expected: "Clients/Acme/invoice-acme-0042.pdf",
    history: false,
  },
  {
    task: "typo",
    query: "renovaton quote",
    expected: "Home/Renovation/kitchen-renovation-quote.pdf",
    history: false,
  },
  {
    task: "by extension",
    query: ".blend",
    expected: "Projects/robot/robot-arm.blend",
    history: false,
  },
  {
    task: "folder by abbreviation",
    query: "rnvtn",
    expected: "Home/Renovation",
    history: false,
  },
  {
    task: "folder by abbreviation",
    query: "hshld",
    expected: "Documents/Household",
    history: false,
  },
  {
    task: "exact name beats a frequently opened weak match",
    query: "notes.txt",
    expected: "Projects/website/notes.txt",
    history: true,
  },
  {
    task: "recently opened among many matches",
    query: "budget",
    expected: "Finance/budget-2026.xlsx",
    history: true,
  },
];

/** Folders a non-admin user is granted, a handful as on a family or team drive. */
export const userGrants = [
  "Documents/Work",
  "Photos/2023",
  "Code/apollo",
  "Finance/2024",
  "Shared",
  "Home",
  "Clients/Acme",
  "Projects",
  "Documents/Household",
  "Finance/Taxes",
  "Finance/budget-2026.xlsx",
] as const;

export type QueryClass =
  | "short"
  | "typical"
  | "rare"
  | "multi"
  | "path"
  | "typo";

export const queryClassNames: readonly QueryClass[] = [
  "short",
  "typical",
  "rare",
  "multi",
  "path",
  "typo",
];

export const queryClasses: Record<QueryClass, readonly string[]> = {
  short: ["a", "s", "r", "2", "in", "re", "20", "ar", "é", "写"],
  typical: [
    "invoice",
    "budget",
    "report",
    "img_2023",
    "config",
    "holiday",
    "draft",
    "beach",
    "thumb",
    "button",
  ],
  rare: [
    "robot-arm.blend",
    "kitchen-renovation-quote",
    "notfound-unique-2843",
    "w2 - employer",
    "写真_家族_1",
    "everything in its right place",
    "permissions-schema",
    "statement-schwab-2024-03",
    "lasagna-recipe.md",
    "meeting notes 2024-03-12",
  ],
  multi: [
    "annual report",
    "2024 invoice",
    "summer beach",
    "project draft",
    "budget final",
    "button test",
    "miles davis blue",
    "christmas 2022",
    "receipt ikea",
    "report annual 2026",
  ],
  path: [
    "finance/2024 invoice",
    "photos/2023 beach",
    "apollo/components button",
    "taxes/2023",
    "music/radiohead",
    "documents/work notes",
    "clients/acme",
    "backups/nas",
    "code/blog readme",
    "videos/shows cosmos",
  ],
  typo: [
    "invioce",
    "budgte",
    "reprot",
    "prjct",
    "thmb",
    "cnfig",
    "lasagan",
    "renovaton",
    "hshld",
    "schdule",
  ],
};
