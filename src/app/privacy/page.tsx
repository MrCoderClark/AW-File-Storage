import type { Metadata } from "next";
import Link from "next/link";
import { Logo } from "@/components/logo";

const appName = process.env.NEXT_PUBLIC_APP_NAME ?? "AW File Storage";
// Contact for data access / deletion requests. Config over hardcoded: set
// NEXT_PUBLIC_PRIVACY_CONTACT per deployment; the fallback is a sensible default.
const privacyContact =
  process.env.NEXT_PUBLIC_PRIVACY_CONTACT ?? "privacy@americaworks.com";

export const metadata: Metadata = {
  title: `Privacy — ${appName}`,
  description:
    "What visitor data our public contact cards collect, why, and how long it is kept.",
};

// Public Privacy page (spec 0030 AC-11), reachable without signing in. Describes
// the visitor data collected on the public card pages, the legitimate-interest
// basis, the 12-month retention, and how to make a data request.
//
// NOTE: this is a structured skeleton. The final, legally reviewed policy copy is
// company-supplied (spec 0030 follow-up); replace the prose below with America
// Works' approved text before relying on it as the published policy.
export default function PrivacyPage() {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 bg-brand-900 px-4 text-white sm:px-6">
        <Logo className="h-8 w-8" />
        <span className="font-semibold">{appName}</span>
      </header>

      <main className="flex-1 bg-canvas px-4 py-10 sm:px-6">
        <article className="mx-auto w-full max-w-2xl rounded-[--radius-drop] border border-border bg-surface p-6 shadow-sm sm:p-8">
          <h1 className="text-2xl font-semibold text-brand-900">Privacy notice</h1>
          <p className="mt-2 text-sm text-muted-500">
            How we handle information about people who view our public contact
            cards. Last updated {new Date().getFullYear()}.
          </p>

          <div className="mt-6 space-y-6 text-sm leading-relaxed text-slate-700">
            <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
              This is a working draft. The final wording is being reviewed and will
              be published here.
            </p>

            <Section title="What this covers">
              <p>
                This notice applies to the public contact card pages we publish
                (for example a card at <code>/c/&lt;name&gt;</code>). It explains
                what we record when someone visits one of those pages and how we
                use it. It does not cover the private, signed-in application used by
                our staff.
              </p>
            </Section>

            <Section title="What we collect">
              <p>
                When you view, scan, download, or save one of our public contact
                cards, we record a single visit event containing:
              </p>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                <li>your public (external) IP address;</li>
                <li>
                  approximate location and network derived from that address —
                  country, region, city, postal area, coarse latitude/longitude,
                  timezone, and the network or internet provider;
                </li>
                <li>
                  your browser&rsquo;s user-agent string (from which we derive a
                  rough device, operating system, and browser);
                </li>
                <li>the page you came from (referrer), if your browser sends it;</li>
                <li>
                  which action occurred (a view, a QR scan, a contact download, or a
                  PDF save) and when.
                </li>
              </ul>
              <p className="mt-2">
                We cannot and do not collect a device&rsquo;s private or internal
                network address. The location is approximate and is not a precise
                position.
              </p>
            </Section>

            <Section title="Why we collect it">
              <p>
                We use this information to understand engagement with our own
                published business cards — how often they are reached, and roughly
                from where and on what kind of device — so we can improve them. Our
                lawful basis for processing this information for visitors in the
                EU/UK is our <strong>legitimate interest</strong> in understanding
                and improving engagement with our own materials. We do not use it to
                build advertising profiles or sell it to anyone.
              </p>
            </Section>

            <Section title="How long we keep it">
              <p>
                Individual visit records are kept for <strong>12 months</strong> and
                are then automatically deleted. Aggregate, non-identifying counts
                (for example, how many times a card was viewed on a given day) may be
                kept longer.
              </p>
            </Section>

            <Section title="Who can see it">
              <p>
                Individual visit detail is restricted to the card owner and our
                administrators inside the signed-in application. It is not shown on
                the public pages.
              </p>
            </Section>

            <Section title="Your choices and requests">
              <p>
                You can ask what we hold about you, or ask us to delete it. Because
                visitors do not have an account with us, we handle these requests
                manually. Contact us at{" "}
                <a
                  href={`mailto:${privacyContact}`}
                  className="font-medium text-brand-700 hover:underline"
                >
                  {privacyContact}
                </a>
                . In any case, the records are automatically removed after 12 months.
              </p>
            </Section>
          </div>

          <div className="mt-8 border-t border-border pt-4 text-sm">
            <Link href="/" className="font-medium text-brand-700 hover:underline">
              &larr; Back to {appName}
            </Link>
          </div>
        </article>
      </main>

      <footer className="flex shrink-0 items-center bg-brand-900 px-4 py-3 text-[11px] text-white/60 sm:px-6">
        <span>
          &copy; {new Date().getFullYear()} America Works. All rights reserved.
        </span>
      </footer>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h2 className="text-base font-semibold text-brand-900">{title}</h2>
      <div className="mt-1.5">{children}</div>
    </section>
  );
}
