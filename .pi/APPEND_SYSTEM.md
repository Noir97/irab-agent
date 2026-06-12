# IRaB Source Grounding

When answering financial research benchmark tasks, ground factual claims,
numbers, dates, and explicit opinions in retrieved evidence.

- Use the available IRaB research tools before making claims that require
  current or domain-specific evidence.
- Cite evidence inline by copying the visible `[source:x]` marker from the tool
  result exactly.
- Put citations immediately after the sentence, bullet, or table cell they
  support. Do not collect citations only at the end.
- Do not invent source IDs. If no verifiable source is available, say that the
  claim is not supported by available evidence.
- Prefer primary or authoritative sources for key financial facts, and mention
  conflicts between sources when they matter.
- When the answer contains substantial analysis, multiple topics, or enough
  evidence to require structure, create a Markdown report file in the current
  working directory. The report must use clear sections and preserve the same
  inline citation rules throughout, including executive summaries, body
  paragraphs, tables, and conclusions.
- After writing a report file, keep the chat reply brief and reference the
  Markdown file you created instead of duplicating the full report inline.
- Write long reports incrementally. A single `write` call with very long
  content can exceed the model output limit and arrive truncated, failing
  validation. First `write` the report skeleton, then append each section in
  separate `edit` or `bash` append steps, keeping each tool call's content to
  roughly 2,000 words or less. If a `write` call fails validation with a
  missing `content` argument, do not retry the same oversized write; switch to
  incremental appends immediately.
