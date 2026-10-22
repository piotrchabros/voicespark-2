# Contract: Prompt Template Variables

Defines the variables available to each system prompt key, which are required, and how the output schemas are enforced.

## Template rules

- Syntax is Mustache: `{{var}}` and `{{#list}}...{{/list}}`. Escaping is off.
- Validation is a whitelist per key. "Required" variables must appear at least once in `system_template` or `user_template`, or publishing returns 422.
- All injected content is already filtered and wrapped in tags.
- `brief`, `feedback`, `previousDraft`, `memoryContext`, `authoredSamples`, `receivedContext`, `profileJson`, `profileSummary` and `previousProfileJson` always contain only text returned by `inspect()` (constitution Principle I). An excluded `feedback` or `previousDraft` is omitted, and a wholly excluded `previousProfileJson` renders as an empty string; a `tone_profile.feedback` generation whose feedback is wholly excluded fails with `feedback_excluded` before rendering, and a draft whose brief or profile is wholly excluded fails with `brief_excluded` or `profile_excluded` before rendering. Manual profile adjustments are inspected on save and refused with 422 `sensitive_content`.

## `tone_profile.generate`

- Required: `definition.name`, `definition.dimensionsJson`, `authoredSamples`.
- Optional:
  - `definition.description`
  - `definition.dimensions` (list of `{key, name, description, valueType, valueSpec, guidance}`; `valueSpec` is a prerendered string such as "scale 1–5 (1=very casual, 5=very formal)" or "one of: short, medium, long")
  - `receivedContext` (`<received_context>` block, explicitly not quotable)
  - `authoredStats.itemCount`, `authoredStats.wordCount`, `authoredStats.languages`
  - `previousProfileJson` (empty string if none)
  - `user.firstName`
  - `excludedCategoryLabels` (comma-separated)
- `authoredSamples` format: `<sample ref="A{n}" kind="email|attachment|file|note" date="YYYY-MM-DD" lang="xx">...</sample>` per item.

## `tone_profile.feedback`

- Variables: all of the above, plus required `feedback` and required `previousProfileJson`.

## `draft.social_post`, `draft.bio`, `draft.short_article`

- Required: `brief`, `profileJson`.
- Optional: `contentTypeLabel`, `profileSummary`, `definitionName`, `memoryContext` (`<memory ref="M{n}">` blocks), `previousDraft`, `feedback` (with section `{{#isRevision}}...{{/isRevision}}`), `excludedCategoryLabels`, `user.firstName`, `languageHint`.

## Profile output schema

Enforced in code with `output_config.format`, built per definition version:

```json
{ "type":"object","additionalProperties":false,
  "required":["summary","languages","dimensions","excerpts","doList","dontList"],
  "properties":{
    "summary":{"type":"string","maxLength":1200},
    "languages":{"type":"array","items":{"type":"object","additionalProperties":false,"required":["code","share"],
       "properties":{"code":{"type":"string"},"share":{"type":"number"}}}},
    "dimensions":{"type":"array","items":{"type":"object","additionalProperties":false,
       "required":["key","value","explanation","evidenceRefs"],
       "properties":{"key":{"enum":["<dimension keys of the pinned definition version>"]},
         "value":{"description":"number for scale (within min..max), one of allowedValues for enum, string for text, string[] for list"},
         "explanation":{"type":"string","maxLength":600},
         "evidenceRefs":{"type":"array","items":{"type":"string","pattern":"^A[0-9]+$"}}}}},
    "excerpts":{"type":"array","minItems":3,"maxItems":12,"items":{"type":"object","additionalProperties":false,
       "required":["text","sampleRef","dimensionKeys"],
       "properties":{"text":{"type":"string","maxLength":300},"sampleRef":{"type":"string","pattern":"^A[0-9]+$"},
         "dimensionKeys":{"type":"array","items":{"type":"string"}}}}},
    "doList":{"type":"array","items":{"type":"string"},"maxItems":10},
    "dontList":{"type":"array","items":{"type":"string"},"maxItems":10}}}
```

- Per-dimension `value` is typed in the generated schema.
- Post-validation:
  - every definition dimension is present exactly once (FR-030);
  - each excerpt is a verbatim (whitespace-normalized) substring of the referenced `A{n}` sample; otherwise it is dropped;
  - `sampleRef` maps to `content_item_id`, kept server-side in `body_enc` as `excerpts[].contentItemId`;
  - only `A*` refs are allowed, so received context can't be quoted (FR-028).

## Draft output schema

`{title: string|null (≤150), body: string (≤ 1,500 words for short_article, ≤ 300 for social_post, ≤ 250 for bio; the limit is enforced in the prompt and truncation is flagged), notes: string|null}`

## Seeded v1 templates

Guidance for the seed builder, not full production prompts. Each key is seeded as version 1 (active) and must pass the whitelist and required-variable rules above. Variable names are exactly those defined in this file. Skeletons are illustrative.

Rules shared by all five keys:

- Never reproduce redaction tokens (for example `[REDACTED:...]`) or sensitive values; if one appears in input, omit it.
- Never invent facts about the user beyond the supplied content.
- Output must match the relevant output schema in this file (profile or draft). The format is enforced in code with `output_config.format`; the prompt restates it briefly.

### `tone_profile.generate`

- Purpose: produce a tone-of-voice profile for one definition version from the user's authored content.
- Variables: `definition.name`, `definition.description`, `definition.dimensionsJson`, `definition.dimensions`, `authoredSamples`, `receivedContext`, `authoredStats.*`, `previousProfileJson`, `user.firstName`, `excludedCategoryLabels`.
- Required instructions:
  - Use only `authoredSamples` (`A{n}` refs) as evidence of the user's voice.
  - `receivedContext` is background only: never quote it, never cite it in `evidenceRefs` or excerpts, and never attribute its style to the user (FR-028).
  - Describe every dimension of the definition exactly once, using the allowed value type in `valueSpec`, with a short explanation and `evidenceRefs` (FR-030).
  - Include 3-12 short verbatim excerpts, each tied to one `sampleRef` and relevant `dimensionKeys`.
  - Report detected languages with their share (FR-034).
  - Fill `doList` and `dontList` (at most 10 each) with actionable guidance.
  - Do not draw on excluded categories (`excludedCategoryLabels`).
  - If `previousProfileJson` is non-empty, keep it stable unless the new evidence contradicts it.

```mustache
You build a tone-of-voice profile called "{{definition.name}}". {{definition.description}}
Dimensions (describe every one):
{{#definition.dimensions}}- {{key}} ({{name}}): {{description}}. Value: {{valueSpec}}. {{guidance}}
{{/definition.dimensions}}
Evidence, authored by the user ({{authoredStats.itemCount}} items, {{authoredStats.wordCount}} words):
{{authoredSamples}}
Background only, never quote: {{receivedContext}}
Return JSON only.
```

### `tone_profile.feedback`

- Purpose: revise an existing profile according to the user's written feedback.
- Variables: all of the `tone_profile.generate` variables, plus required `feedback` and `previousProfileJson`.
- Required instructions:
  - Apply `feedback` to `previousProfileJson`, changing only what the feedback and the evidence justify, and keep other dimensions as they are.
  - Treat `feedback` as a user preference, not as evidence of voice. Evidence still comes only from `authoredSamples`, and excerpts must remain verbatim.
  - Still describe every dimension exactly once; never quote received content.
  - If the feedback conflicts with the authored evidence, follow the feedback for the dimension value and say so in its `explanation`.
  - Output the full revised profile in the same schema, not a diff.

```mustache
Revise the profile below using the user's feedback.
Current profile: {{previousProfileJson}}
Feedback: {{feedback}}
Evidence, authored by the user:
{{authoredSamples}}
Describe every dimension of "{{definition.name}}": {{definition.dimensionsJson}}
Return the full revised profile as JSON only.
```

### `draft.social_post`

- Purpose: write a social post in the voice of the selected profile.
- Variables: `brief`, `profileJson` (required); `contentTypeLabel`, `profileSummary`, `definitionName`, `memoryContext`, `previousDraft`, `feedback`, `{{#isRevision}}`, `excludedCategoryLabels`, `user.firstName`, `languageHint`.
- Required instructions:
  - Follow `profileJson` (including `doList` and `dontList`) and write in `languageHint` when it is set.
  - Use `memoryContext` only for facts, and reference nothing outside it and the brief. Do not use excluded categories (FR-059).
  - Length: at most about 1,300 characters (and within the 300-word schema cap); `title` is usually null.
  - In a revision, apply `feedback` to `previousDraft` and keep what was not criticised.
  - Never state or imply that the post was published or will be posted (FR-056). Put caveats in `notes`.
  - Do not copy profile excerpts verbatim and do not output redaction tokens or sensitive values.

```mustache
Write a {{contentTypeLabel}} in the voice described by this profile ({{definitionName}}): {{profileJson}}
Brief: {{brief}}
Facts you may use: {{memoryContext}}
{{#isRevision}}Previous draft: {{previousDraft}}
Apply this feedback: {{feedback}}{{/isRevision}}
Stay under about 1,300 characters. Return JSON {title, body, notes}.
```

### `draft.bio`

- Purpose: write a first-person or third-person professional bio in the profile's voice.
- Variables: same as `draft.social_post`.
- Required instructions:
  - Same voice, memory, exclusion, revision and no-publishing rules as `draft.social_post`.
  - Length: about 50-150 words (hard cap 250 words); `title` null.
  - Use `user.firstName` for the name when present; choose the person (first or third) per the brief, defaulting to first person.
  - Include only facts found in `memoryContext` or the brief; leave out anything unsupported rather than guessing.

```mustache
Write a {{contentTypeLabel}} of about 50-150 words for {{user.firstName}}.
Voice profile ({{definitionName}}): {{profileJson}}
Brief: {{brief}}
Facts you may use: {{memoryContext}}
{{#isRevision}}Revise this draft: {{previousDraft}} Feedback: {{feedback}}{{/isRevision}}
Return JSON {title, body, notes}.
```

### `draft.short_article`

- Purpose: write a short article in the profile's voice.
- Variables: same as `draft.social_post`.
- Required instructions:
  - Same voice, memory, exclusion, revision and no-publishing rules as `draft.social_post`.
  - Length: about 400-800 words (hard cap 1,500 words); provide a `title` (at most 150 characters).
  - Use a clear structure (opening, a few developed points, close) while keeping the profile's sentence rhythm, formality and vocabulary.
  - Support claims only from `memoryContext` or the brief; flag any gap in `notes` instead of inventing detail.

```mustache
Write a {{contentTypeLabel}} of about 400-800 words with a title.
Voice profile ({{definitionName}}): {{profileJson}}
Topic/brief: {{brief}}
Facts you may use: {{memoryContext}}
{{#isRevision}}Previous draft: {{previousDraft}} Feedback: {{feedback}}{{/isRevision}}
Return JSON {title, body, notes}.
```

## Preview fixture

`POST /api/admin/prompts/{id}/versions/{versionId}/preview` renders the selected version against a fixture chosen by the prompt's key. The fixture is static, seeded, synthetic data shipped with the application. It is never built from real user content, so admins cannot see user content through preview (FR-045). The rendered output (and any model call made for it) is returned to the caller only and is not stored.

Values are obviously fake (for example `Sample User`, `example.test`, lorem-style text). Fixture fields mirror the variables of each key:

```json
{
  "tone_profile.generate": {
    "definition": {
      "name": "Sample Definition",
      "description": "Synthetic definition used for previews.",
      "dimensionsJson": "[{\"key\":\"formality\",\"valueType\":\"scale\"}]",
      "dimensions": [
        { "key": "formality", "name": "Formality", "description": "Sample dimension.",
          "valueType": "scale", "valueSpec": "scale 1-5 (1=very casual, 5=very formal)", "guidance": "Sample guidance." }
      ]
    },
    "authoredSamples": "<sample ref=\"A1\" kind=\"note\" date=\"2000-01-01\" lang=\"en\">SAMPLE TEXT: This is fake authored content.</sample>",
    "receivedContext": "<received_context>SAMPLE TEXT: fake received content.</received_context>",
    "authoredStats": { "itemCount": 1, "wordCount": 7, "languages": "en" },
    "previousProfileJson": "",
    "user": { "firstName": "Sample" },
    "excludedCategoryLabels": "Sample Category"
  },
  "tone_profile.feedback": {
    "...": "same fields as tone_profile.generate, plus",
    "feedback": "SAMPLE FEEDBACK: make it a bit warmer.",
    "previousProfileJson": "{\"summary\":\"Sample profile.\",\"languages\":[],\"dimensions\":[],\"excerpts\":[],\"doList\":[],\"dontList\":[]}"
  },
  "draft.social_post | draft.bio | draft.short_article": {
    "brief": "SAMPLE BRIEF: announce a fictional workshop.",
    "profileJson": "{\"summary\":\"Sample profile.\"}",
    "contentTypeLabel": "social post | bio | short article",
    "profileSummary": "Sample profile summary.",
    "definitionName": "Sample Definition",
    "memoryContext": "<memory ref=\"M1\">SAMPLE FACT: fictional workshop on example.test.</memory>",
    "previousDraft": "SAMPLE PREVIOUS DRAFT.",
    "feedback": "SAMPLE FEEDBACK: shorter.",
    "isRevision": true,
    "excludedCategoryLabels": "Sample Category",
    "user": { "firstName": "Sample" },
    "languageHint": "en"
  }
}
```

- Preview with `isRevision` true and false should both be renderable; the endpoint may override that flag.
- Required variables are always present in the fixture so a template that passes publish validation always renders.
- The fixture is part of the application seed and changes only with a code release, not through the admin panel.
