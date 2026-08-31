// America Works signature branding (spec 0009). ONE editable place for the
// org-wide links, socials, colours, and disclaimer that wrap a person's parsed
// vCard into a print/email signature. Most URLs below are PLACEHOLDERS pending
// the real ones from the engineer (americaworks.com, Employers, Job Seekers,
// "Schedule a meeting") — swap the values here, no code change needed.
//
// Socials are PER STATE: a person's card carries their work address, so we pick
// the regional social set from `socialsByState` keyed by the card's state, and
// fall back to `socials` (org-wide) when there's no entry. New York is wired up;
// add more states by dropping another entry into `socialsByState`.

export interface Socials {
  facebook?: string;
  x?: string;
  instagram?: string;
  linkedin?: string;
}

export interface SignatureBrand {
  /** Company display name (shown under the logo). */
  companyName: string;
  /** Public path to the logo served by the app (used as an absolute URL in email). */
  logoPath: string;
  /** Primary marketing site. */
  websiteUrl: string;
  websiteLabel: string;
  /** Audience links shown beside the logo. */
  employersUrl: string;
  jobSeekersUrl: string;
  /** One org-wide "Schedule a meeting" link. */
  scheduleMeetingUrl: string;
  /** Org-wide social fallback (used when the card's state has no override). */
  socials: Socials;
  /** Per-state social overrides, keyed by 2-letter state abbreviation (e.g. "NY"). */
  socialsByState: Record<string, Socials>;
  /** Brand red used for the full-height divider. */
  accentColor: string;
  /** Brand navy used for the name + title. */
  headingColor: string;
  /** Body text colour (contact values, address). */
  textColor: string;
  /** Bold contact-label colour ("telephone:", "mobile:", "email:"). */
  labelColor: string;
  /** Hyperlink colour (website, audience, phone/email values). */
  linkColor: string;
  /** "Schedule a meeting" button background. */
  buttonColor: string;
  /** Muted text colour (disclaimer). */
  mutedColor: string;
  /** Confidentiality footer shown beneath the signature. */
  disclaimer: string;
}

export const AW_SIGNATURE_BRAND: SignatureBrand = {
  companyName: "America Works of New York, Inc.",
  logoPath: "/aw-logo.png",
  // TODO(engineer): replace the four placeholder URLs below with the real links.
  websiteUrl: "https://www.americaworks.com",
  websiteLabel: "americaworks.com",
  employersUrl: "https://www.americaworks.com/employers",
  jobSeekersUrl: "https://www.americaworks.com/job-seekers",
  scheduleMeetingUrl: "https://www.americaworks.com/schedule",
  // Org-wide fallback socials (placeholders) for states without an override.
  socials: {
    facebook: "https://www.facebook.com/AmericaWorks",
    x: "https://twitter.com/americaworks",
    instagram: "https://www.instagram.com/americaworks",
  },
  socialsByState: {
    NY: {
      facebook: "https://www.facebook.com/AWNewYork",
      x: "https://twitter.com/americaworksnys?lang=en",
      instagram: "https://www.instagram.com/americaworksny",
    },
  },
  accentColor: "#c8102e",
  headingColor: "#1f3864",
  textColor: "#222222",
  labelColor: "#1a1a1a",
  linkColor: "#1155cc",
  buttonColor: "#2f80d6",
  mutedColor: "#666666",
  disclaimer:
    "This email and any files transmitted with it are confidential and intended solely for the use of the individual or entity to whom they are addressed. If you have received this email in error, please notify us immediately and delete the message from your system.",
};

// Full US state/territory name → 2-letter abbreviation, so a card storing either
// "New York" or "NY" resolves the same. Keys are lower-cased for lookup.
const US_STATES: Record<string, string> = {
  alabama: "AL",
  alaska: "AK",
  arizona: "AZ",
  arkansas: "AR",
  california: "CA",
  colorado: "CO",
  connecticut: "CT",
  delaware: "DE",
  "district of columbia": "DC",
  florida: "FL",
  georgia: "GA",
  hawaii: "HI",
  idaho: "ID",
  illinois: "IL",
  indiana: "IN",
  iowa: "IA",
  kansas: "KS",
  kentucky: "KY",
  louisiana: "LA",
  maine: "ME",
  maryland: "MD",
  massachusetts: "MA",
  michigan: "MI",
  minnesota: "MN",
  mississippi: "MS",
  missouri: "MO",
  montana: "MT",
  nebraska: "NE",
  nevada: "NV",
  "new hampshire": "NH",
  "new jersey": "NJ",
  "new mexico": "NM",
  "new york": "NY",
  "north carolina": "NC",
  "north dakota": "ND",
  ohio: "OH",
  oklahoma: "OK",
  oregon: "OR",
  pennsylvania: "PA",
  "rhode island": "RI",
  "south carolina": "SC",
  "south dakota": "SD",
  tennessee: "TN",
  texas: "TX",
  utah: "UT",
  vermont: "VT",
  virginia: "VA",
  washington: "WA",
  "west virginia": "WV",
  wisconsin: "WI",
  wyoming: "WY",
  "puerto rico": "PR",
};

/** US states/territories as `{ abbr, name }`, sorted by name — for a picker UI. */
export const US_STATE_OPTIONS: { abbr: string; name: string }[] = Object.entries(
  US_STATES,
)
  .map(([name, abbr]) => ({
    abbr,
    name: name.replace(/\b\w/g, (c) => c.toUpperCase()),
  }))
  .sort((a, b) => a.name.localeCompare(b.name));

/**
 * Normalise a vCard state value to its 2-letter abbreviation, or "" if it can't
 * be resolved. Accepts either the abbreviation ("ny", "NY") or the full name
 * ("New York").
 */
export function normalizeState(state: string): string {
  const raw = state.trim();
  if (!raw) return "";
  const upper = raw.toUpperCase();
  if (upper.length === 2) return upper;
  return US_STATES[raw.toLowerCase()] ?? "";
}

/** The social set for a card's state, falling back to the org-wide socials. */
export function socialsForState(brand: SignatureBrand, state: string): Socials {
  const abbr = normalizeState(state);
  return (abbr && brand.socialsByState[abbr]) || brand.socials;
}
