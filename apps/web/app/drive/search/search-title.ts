/** A search results page's title, the same in the page and in its skeleton. */
export const SearchTitle = {
  of: (query: string) => `Search: ${query}`,
} as const;
