/** Lightweight source-language metadata derived only from recognized Unicode script evidence. */

/**
 * Infer a source language from recognized scripts without guessing for unmatched text.
 * @param text - Original user request or authored semantic text.
 * @returns an open language tag, or undefined when the script does not determine one.
 */
export function sourceLanguageFromText(text: string): string | undefined {
  if (/\p{Script=Hiragana}|\p{Script=Katakana}/u.test(text)) return 'ja'
  if (/\p{Script=Hangul}/u.test(text)) return 'ko'
  if (/\p{Script=Han}/u.test(text)) return 'zh'
  return undefined
}
