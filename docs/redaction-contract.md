# Redaction contract: what may cross a public surface

The rule this module enforces is narrow and checkable:

> A stored secret value never leaves the module that read it. A public surface
> carries a mask at most, and a model usage count is published only when it is a
> plain finite non-negative number under a known counter name.

`src/config/redact.js` is the only component that decides this. Configuration
surfaces, job history, MCP results, review findings, audit diagnostics and logs
all funnel through it.

---

## 1. The secret-key rule

`isSecretKey(key)` returns true when the key matches:

```
/(api[_-]?key|apikey|secret|token|password|passwd|credential[_-]?value|authorization)/i
```

This is a substring test, on purpose: `RELAY_API_KEY`, `access_token`,
`dbPassword` and `client_secret` are all caught without enumerating them. It also
means the rule is coarse — it cannot tell a credential from a count that merely
spells the same word.

`redactDeep` therefore masks the value behind such a key, with one exemption
described next.

## 2. The usage-counter exemption (the narrow fix)

Model token counts are named `inputTokens`, `totalTokens`, `reasoningTokens`, …
Every one of those names contains `token`, so before this contract they were all
masked and a job record reported nothing about what the run consumed. The
exemption restores exactly that, and nothing more.

`isUsageCounter(key, value)` is true when **both** hold:

1. `key` is one of these exact names:

   ```
   inputTokens        input_tokens
   outputTokens       output_tokens
   totalTokens        total_tokens
   reasoningTokens    reasoning_tokens
   cacheTokens        cache_tokens
   cacheReadTokens    cache_read_tokens
   cacheWriteTokens   cache_write_tokens
   ```

   (`TokenUsage` in `@deepseek-ai/dsh-llm` uses the camel forms; the snake forms
   cover OpenAI-compatible wire payloads. Both spellings are listed for the same
   seven counters.)

2. `value` is `typeof 'number'`, `Number.isFinite(value)` and `value >= 0`.

### Why this is an allow-list and not a `*Tokens` suffix rule

A suffix rule would exempt `refreshTokens`, `approvalTokens` and every credential
field that will ever end in those letters — a permanent hole for the sake of one
counter family. The allow-list keeps the hole to the names actually read from a
model response, and leaves every future unknown name masked by default. That is
the safe direction for a mistake to point.

### Why the value type matters

A counter name proves nothing about the value. `inputTokens: 'sk-abc…'` is a
credential that happens to sit under a counter name, and
`inputTokens: { raw: 'sk-abc…' }` is a nested object holding one. Neither is a
count, so neither is exempt:

| value | result |
| --- | --- |
| `12`, `0`, `1.5` | published as the number |
| `-1`, `NaN`, `Infinity` | masked — not a count |
| `'12'`, `'sk-abc…'` | masked — a string is never a count |
| `{ raw: 12 }`, `[1, 2]`, `true` | masked |
| `null` / `undefined` / `''` | passed through as `null` (no value to hide) |

The empty/null case is the existing rule for all secret keys, not a new
exception: an absent credential is not a credential.

## 3. Free text

`redactText` is the safety net for values the plugin never intended to see. It
runs over every string `redactDeep` visits, including strings inside a preserved
structure:

| pattern | replaced with |
| --- | --- |
| `Bearer <12+ token chars>` | `Bearer ••••••••` |
| `sk-…` / `pk-…` / `ak-…` (16+ chars) | `••••••••` |
| `SOMETHING_TOKEN=value` | `SOMETHING_TOKEN=••••••••` |

A preserved usage counter is a number, so it never carries text. A counter-shaped
key whose value is a string still goes through `redactText` and then is masked
whole — a credential-shaped string under `total_tokens` is masked, not published.

## 4. `maskSecret` never leaks shape

`maskSecret` returns the fixed `MASK` (`••••••••`) for any non-empty string, and
`''` for empty input. It does not keep a prefix, a suffix or the length, because a
partial mask is a partial credential.

## 5. What is *not* redacted

- Numbers and booleans under names that are not secret keys.
- `credentialRef` — a reference is a name, not a value; it is expected in public
  settings.
- The mask itself, which is not a secret.

Structural fields are preserved so a host can still act on them: `code`, `phase`,
`outcome`, `agentId`, `sessionId` and the job's `usage` counters. Nothing in the
exemption path widens what a caller can learn about a credential.

## 6. Keeping this honest

`tests/redact.test.js` covers the reported bug, each known counter spelling, the
suffix-rule regression (`refreshTokens` and friends must stay masked), every
invalid-value shape, numeric secret token values, unknown token names, and
credential-shaped strings under a counter name. `tests/config.test.js` covers the
public-settings projection end to end.

Adding a counter means adding it to `USAGE_COUNTER_KEYS` *and* to the test table.
Adding a name there widens the one exemption in this module, so it deserves the
review that any other relaxation of a secret rule would get.
