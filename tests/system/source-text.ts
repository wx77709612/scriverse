export function normalizeSourceText(value: string): string {
  return value.replace(/\r\n?/gu, "\n");
}

export function normalizeSourceTexts<T extends readonly string[]>(values: T): T {
  return values.map(normalizeSourceText) as unknown as T;
}

export function normalizeSourceResponses(...responses: Array<{ text?: string }>): void {
  for (const response of responses) {
    if (typeof response.text === "string") response.text = normalizeSourceText(response.text);
  }
}
