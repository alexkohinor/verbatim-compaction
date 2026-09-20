/**
 * A rough token count for reporting only — nothing in this library depends on
 * it, because nothing is sent anywhere. Scripts are charged separately so a
 * Russian or Chinese transcript is not counted as if it were English: Latin
 * text runs about four characters per token, Cyrillic and Greek about two,
 * CJK about one.
 */
export function estimateTokens(text: string): number {
  let latin = 0;
  let wide = 0;
  let mid = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x0370) latin += 1;
    else if (
      (code >= 0x3000 && code <= 0x9fff) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      code >= 0x1f300
    ) {
      wide += 1;
    } else mid += 1;
  }
  return Math.ceil(latin / 4 + mid / 2 + wide);
}
