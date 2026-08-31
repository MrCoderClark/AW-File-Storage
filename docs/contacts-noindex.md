# Keep published vCards out of search results (spec 0001 AC-17)

> **Status: applied + verified (2026-08-31).** The rule below is live on the
> `awvcard.com` zone; a published card returns `x-robots-tag: noindex, nofollow`.
> This doc stays as the reproducible spec for the rule.

Published cards are served **directly from the R2 public bucket** (`aw-files-public`)
via its custom domain `contacts.awvcard.com`. The app Worker is **not** in that
request path, and R2 only emits standard object metadata (`Content-Type`,
`Content-Disposition`, `Cache-Control`, …) — **not** `X-Robots-Tag`. So the
de-index signal can't come from app code; it lives at the Cloudflare edge as a
**Response Header Transform Rule** on the `awvcard.com` zone.

## The rule

- **Header:** `X-Robots-Tag: noindex, nofollow`
- **Scope:** every response where `http.host eq "contacts.awvcard.com"`

**Why a header and not a `robots.txt` `Disallow`:** a `Disallow` stops crawlers
fetching the file, so they never see the `noindex` — and a URL that's linked
anywhere can still be indexed "URL-only." Leaving the path crawlable **and**
tagging it `noindex` is Google's recommended way to keep something out of
results. (If you also want to discourage well-behaved bots from crawling at all,
a `robots.txt` can be added later, but the header is the authoritative signal.)

## Apply via the dashboard (recommended)

1. Cloudflare → the **awvcard.com** zone → **Rules → Transform Rules → Modify
   Response Header → Create rule**.
2. **Name:** `noindex published vCards`.
3. **If** → *Custom filter expression*: Field **Hostname**, Operator **equals**,
   Value **`contacts.awvcard.com`**.
4. **Then** → **Set static** → Header **`X-Robots-Tag`**, Value **`noindex, nofollow`**.
5. **Deploy.**

## Or apply via the API (one shot)

Needs an API token with **Zone → Config Rules → Edit** (Transform Rules) and the
zone id. ⚠️ A `PUT` to the phase entrypoint **replaces** every response-header
transform rule in the zone — if you already have some, `GET` them first and
append instead of overwriting.

```sh
CF_API_TOKEN=<token>
# Look up the zone id:
ZONE_ID=$(curl -s "https://api.cloudflare.com/client/v4/zones?name=awvcard.com" \
  -H "Authorization: Bearer $CF_API_TOKEN" | grep -oE '"id":"[a-f0-9]{32}"' | head -1 | cut -d'"' -f4)

curl -X PUT "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/rulesets/phases/http_response_headers_transform/entrypoint" \
  -H "Authorization: Bearer $CF_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"rules":[{"action":"rewrite","action_parameters":{"headers":{"X-Robots-Tag":{"operation":"set","value":"noindex, nofollow"}}},"expression":"http.host eq \"contacts.awvcard.com\"","description":"noindex published vCards"}]}'
```

## Verify

```sh
curl.exe -I https://contacts.awvcard.com/c/<Some_Published_Slug>.vcf
```

Expect `x-robots-tag: noindex, nofollow` among the response headers.
