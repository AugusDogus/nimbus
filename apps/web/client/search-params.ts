/**
 * Plain `?key=value` search strings, as the server and other links write them. The router's
 * default JSON encoding would turn `?before=123` into a number and quote string values.
 */
export type SearchParams = Record<string, string>;

export const SearchParams = {
  parse(search: string): SearchParams {
    return Object.fromEntries(new URLSearchParams(search));
  },
  stringify(search: Record<string, unknown>): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(search))
      if (typeof value === "string" && value !== "") params.set(key, value);
    const text = params.toString();
    return text ? `?${text}` : "";
  },
  /** The string value of `key`, or undefined when it is absent or not a string. */
  string(search: Record<string, unknown>, key: string): string | undefined {
    const value = search[key];
    return typeof value === "string" ? value : undefined;
  },
} as const;
