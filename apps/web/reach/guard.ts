/**
 * Finds code that decides what a person can reach by the window's width rather than through the
 * Device module (`lib/device.ts`): a control hidden by a viewport class, or a read of the window's
 * size or media queries. It reads source text line by line, relying on the formatter's layout of
 * JSX, so it is a tripwire, not a proof. What it cannot see:
 *
 * - Controls left out by JavaScript on a width-derived flag (`{wide && <Button />}`), or hidden
 *   by a variable whose classes are built elsewhere and passed in.
 * - Hiding in CSS files, container queries (`@md:hidden`, which follow a component's own room
 *   and are allowed), `display` set in styles, or `opacity-0` without a hover to reveal it.
 * - Whether the other route a reason comment names exists. The reach check
 *   (`e2e/reach.e2e.ts`) tests that for the file actions it covers.
 */

export type ReachFinding = {
  line: number;
  text: string;
  rule: "control hidden by width" | "reads the window";
};

/** A comment that names the other route: `// reach: the sort drawer offers sorting`. */
const reason = /(\/\/|\/\*|\*)\s*reach:\s*\S/;

const breakpoint = String.raw`(?:max-|min-)?(?:sm|md|lg|xl|2xl|\[[^\]\s]+\])`;
/** A viewport variant, alone or among others, then a utility that hides. */
const hides = new RegExp(
  String.raw`^!?(?:[\w-]+:)*${breakpoint}:(?:[\w-]+:)*!?(?:hidden|invisible|sr-only)$`,
);
/** A viewport variant that shows what plain `hidden` hid. */
const shows = new RegExp(
  String.raw`^!?(?:[\w-]+:)*${breakpoint}:(?:[\w-]+:)*!?(?:flex|inline-flex|block|inline|inline-block|grid|inline-grid|table|contents|flow-root|not-sr-only|visible)$`,
);
const strings =
  /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|`([^`\\]*(?:\\.[^`\\]*)*)`/g;

/** Whether one string of classes hides something by the window's width. */
function hidesByWidth(classes: string) {
  const tokens = classes.split(/\s+/).filter(Boolean);
  return (
    tokens.some((token) => hides.test(token)) ||
    (tokens.includes("hidden") && tokens.some((token) => shows.test(token)))
  );
}

const reads =
  /\bmatchMedia\s*\(|\binnerWidth\b|\bouterWidth\b|\bscreen\.width\b/;

const interactive =
  /<(?:button|a|input|select|textarea|summary|label)\b|<(?:[A-Z]\w*\.)?(?:Button|Link|\w+Link|MenuItem|\w*Trigger|Toggle\w*|Input|Select\w*|Checkbox|Switch|Tab|DrawerClose|Action|\w+Action)\b|\bonClick=|\bhref=|role="(?:button|link|menuitem|tab|checkbox|switch|option)"/;

const indent = (line: string) => line.length - line.trimStart().length;
const isComment = (line: string) => /^\s*(\/\/|\/\*|\*|\{\s*\/\*)/.test(line);
const opensTag = (line: string) => /^\s*<[A-Za-z]/.test(line);

/**
 * The lines of the JSX element a class on `at` belongs to, from its opening tag to its close,
 * or null when the class is not inside an element's tag, as in a constant or an object.
 */
function elementAround(lines: readonly string[], at: number) {
  let start = -1;
  const here = lines[at] ?? "";
  if (opensTag(here)) start = at;
  else
    for (let index = at - 1; index >= Math.max(0, at - 12); index--) {
      const line = lines[index] ?? "";
      if (indent(line) >= indent(here) && !opensTag(line)) continue;
      if (opensTag(line) && indent(line) < indent(here)) start = index;
      break;
    }
  if (start < 0) return null;
  const open = lines[start] ?? "";
  // One line, self-closing or with its close on the same line.
  if (/\/>\s*[)}]?\s*$/.test(open) || /<\/[\w.]+>\s*[)}]?\s*$/.test(open))
    return { start, end: start };
  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (indent(line) < indent(open)) return { start, end: index - 1 };
    if (indent(line) === indent(open) && /^\s*(<\/|\/>)/.test(line))
      return { start, end: index };
  }
  return { start, end: lines.length - 1 };
}

/** Whether a reason comment sits on `index` or the line above it. */
const hasReason = (lines: readonly string[], index: number) =>
  reason.test(lines[index] ?? "") || reason.test(lines[index - 1] ?? "");

/** What in `source` breaks the reach rules, by 1-based line. */
function scan(source: string, options: { mayReadWindow: boolean }) {
  const lines = source.split("\n");
  const findings: ReachFinding[] = [];
  lines.forEach((text, index) => {
    if (isComment(text)) return;
    if (!options.mayReadWindow && reads.test(text) && !hasReason(lines, index))
      findings.push({
        line: index + 1,
        text: text.trim(),
        rule: "reads the window",
      });
    let hiding = false;
    for (const match of text.matchAll(strings))
      if (hidesByWidth(match[1] ?? match[2] ?? match[3] ?? "")) hiding = true;
    if (!hiding || hasReason(lines, index)) return;
    const element = elementAround(lines, index);
    if (element && hasReason(lines, element.start)) return;
    // A class outside any element might go on anything: it counts as hiding a control.
    const subtree = element
      ? lines.slice(element.start, element.end + 1).join("\n")
      : "<unknown>";
    if (element && !interactive.test(subtree)) return;
    findings.push({
      line: index + 1,
      text: text.trim(),
      rule: "control hidden by width",
    });
  });
  return findings;
}

export const ReachGuard = { scan, hidesByWidth } as const;
