import { pt } from "./pt";
import { en } from "./en";

/**
 * The game's two languages. Every text the player reads comes from `pt.ts` / `en.ts` through
 * `t()`; the language can change at any time (main menu, pause), and whatever is on screen
 * follows through `onLanguageChange`.
 */
export type Language = "pt" | "en";

export const LANGUAGES: readonly Language[] = ["pt", "en"];

/** The shape of a catalogue. `en.ts` is typed with it, so a missing text fails the build. */
export type Messages = typeof pt;

type Leaves<T, Prefix extends string = ""> = {
  [K in keyof T & string]: T[K] extends string ? `${Prefix}${K}` : Leaves<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

/** Every text's key, dotted: `"menu.play"`, `"editor.hint.select"`… */
export type MessageKey = Leaves<Messages>;

export type MessageParams = Readonly<Record<string, string | number>>;

/** A text held in data rather than in the catalogues: a level's name, a pack's label. */
export interface LocalizedText {
  readonly pt: string;
  readonly en: string;
}

const CATALOGS: Readonly<Record<Language, Messages>> = { pt, en };

let current: Language = "pt";
const listeners = new Set<(language: Language) => void>();
let persist: ((language: Language) => void) | null = null;

export const isLanguage = (value: unknown): value is Language =>
  value === "pt" || value === "en";

/** Portuguese for a browser set to any Portuguese, English for everything else. */
export const detectLanguage = (
  browser: string | undefined = typeof navigator === "undefined" ? undefined : navigator.language,
): Language => (browser?.toLowerCase().startsWith("pt") ? "pt" : "en");

export const getLanguage = (): Language => current;

/** The BCP 47 locale for numbers, dates and sorting in the current language. */
export const getLocale = (): string => (current === "pt" ? "pt-BR" : "en-US");

/**
 * Sets the language at start-up, from the save (or the browser when the save has none), and
 * how later changes are saved. Does not notify: nothing is on screen yet.
 */
export const initLanguage = (
  saved: Language | null | undefined,
  save?: (language: Language) => void,
): Language => {
  current = isLanguage(saved) ? saved : detectLanguage();
  persist = save ?? null;
  syncDocument();
  return current;
};

/** Switches the language, saves it and re-renders everything that listens. */
export const setLanguage = (language: Language): void => {
  if (!isLanguage(language) || language === current) return;
  current = language;
  syncDocument();
  persist?.(language);
  for (const listener of [...listeners]) listener(language);
};

/** Runs `listener` after every language change; returns the unsubscribe. */
export const onLanguageChange = (listener: (language: Language) => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const lookup = (catalog: Messages, key: string): string | undefined => {
  let node: unknown = catalog;
  for (const part of key.split(".")) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string" ? node : undefined;
};

const interpolate = (text: string, params?: MessageParams): string =>
  params ? text.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match)) : text;

/** The text for `key` in the current language, with `{name}` placeholders filled in. */
export const t = (key: MessageKey, params?: MessageParams): string => translate(key, params);

/**
 * `t` for a key built at run time (`ingredients.${id}`). Falls back to Portuguese, then to
 * `fallback` (or the key itself), so content added without a translation still reads.
 */
export const translate = (key: string, params?: MessageParams, fallback?: string): string => {
  const text = lookup(CATALOGS[current], key) ?? lookup(pt, key) ?? fallback ?? key;
  return interpolate(text, params);
};

/** Whether `key` names a text (for content that may or may not have one). */
export const hasText = (key: string): boolean => lookup(pt, key) !== undefined;

/**
 * A label table (`{ stove: "Fogão", … }`) whose values are read from the catalogue under
 * `prefix` each time they are accessed, so a table built at start-up follows the language.
 * Spreading it copies today's texts; read through it instead.
 */
export const localizedRecord = <K extends string>(
  keys: readonly K[],
  prefix: string,
): Readonly<Record<K, string>> => {
  const record = {} as Record<K, string>;
  for (const key of keys) {
    Object.defineProperty(record, key, {
      get: () => translate(`${prefix}.${key}`),
      enumerable: true,
    });
  }
  return record;
};

/** Picks the current language's side of a text held in data. */
export const localized = (text: LocalizedText | string | undefined, fallback = ""): string =>
  text === undefined ? fallback : typeof text === "string" ? text : text[current] || text.pt;

export const formatNumber = (value: number, options?: Intl.NumberFormatOptions): string =>
  new Intl.NumberFormat(getLocale(), options).format(value);

export const formatDate = (value: number | Date, options?: Intl.DateTimeFormatOptions): string =>
  new Intl.DateTimeFormat(getLocale(), options).format(value);

/** Locale-aware comparison for sorting what the player reads. */
export const compareText = (a: string, b: string): number => a.localeCompare(b, getLocale());

/**
 * Fills a static piece of markup: `data-i18n="key"` sets the text, and
 * `data-i18n-attr="aria-label:key;title:key"` sets attributes. `data-i18n-params` holds
 * JSON placeholders. Run again after a language change to re-translate it in place.
 */
export const applyTranslations = (root: ParentNode): void => {
  const params = (element: Element): MessageParams | undefined => {
    const raw = element.getAttribute("data-i18n-params");
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as MessageParams;
    } catch {
      return undefined;
    }
  };
  for (const element of root.querySelectorAll("[data-i18n]")) {
    element.textContent = translate(element.getAttribute("data-i18n") ?? "", params(element));
  }
  for (const element of root.querySelectorAll("[data-i18n-attr]")) {
    for (const pair of (element.getAttribute("data-i18n-attr") ?? "").split(";")) {
      const [attribute, key] = pair.split(":").map((part) => part.trim());
      if (attribute && key) element.setAttribute(attribute, translate(key, params(element)));
    }
  }
};

const syncDocument = (): void => {
  if (typeof document === "undefined") return;
  document.documentElement.lang = getLocale();
};
