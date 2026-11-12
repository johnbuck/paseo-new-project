const SECRET_PATTERNS: RegExp[] = [
  // Authorization headers, with or without the scheme word
  /\bauthorization\s*[:=]\s*(?:(?:bearer|basic|token)\s+[a-z0-9._~+/=-]{8,}|[^\s,"'`]{8,})/gi,
  // Credentials embedded in a URL: scheme://user:pass@host
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/"'`]+:[^\s@/"'`]+@[^\s"'`]+/gi,
  // Well-known token shapes
  /\bsk-[a-z0-9_-]{8,}/gi,
  /\bgh[pousr]_[a-z0-9]{20,}/gi,
  /\bgithub_pat_[a-z0-9_]{20,}/gi,
  /\bnpm_[a-z0-9]{30,}/gi,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[baprs]-[a-z0-9-]{10,}/gi,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g,
  // PEM blocks: terminated pairs first, then any unterminated remainder
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*/g,
  // Key/value assignments. The key may carry any prefix/suffix (OPENAI_API_KEY,
  // _authToken, DB_PASSWORD), optional surrounding quotes (JSON), and the value
  // may be quoted — spaces included — or a bare run.
  /["']?[a-z0-9_.-]*(?:api[_-]?key|apikey|token|secret|password|passwd|credential|auth)[a-z0-9_.-]*["']?\s*[:=]\s*(?:"[^"\n]{4,}"|'[^'\n]{4,}'|[^\s,"'`]{8,})/gi,
];

export function scrubSecrets(text: string): string {
  let scrubbed = text;
  for (const pattern of SECRET_PATTERNS) {
    scrubbed = scrubbed.replace(pattern, "[redacted]");
  }
  return scrubbed;
}
