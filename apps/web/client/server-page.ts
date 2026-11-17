import { redirect } from "@tanstack/react-router";

/**
 * Leaves the app for a page the server renders, such as sign-in: a navigation inside the app
 * that reaches one loads it from the server instead.
 */
export function loadFromServer(href: string): never {
  throw redirect({ href, reloadDocument: true });
}
